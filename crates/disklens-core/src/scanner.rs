//! 通用扫描器：rayon 工作窃取并行遍历目录（所有平台、所有文件系统可用）。
//!
//! 分两个阶段：
//!
//! 1. **并行阶段**：每个目录是一个任务，负责读取它的直接子项；子目录交给
//!    `into_par_iter` 递归并行，rayon 自动做负载均衡。
//! 2. **扁平化阶段**：用显式栈把临时结构转换为 [`FlatTree`]，O(n)，不递归，
//!    转换过程中临时结构被逐步释放。
//!
//! 性能要点：
//! * Windows 上 `DirEntry::metadata()` 直接使用 `FindNextFileW` 返回的数据，不额外调用系统；
//! * 进度计数器按目录批量累加，而不是每个文件一次原子操作；
//! * 跳过符号链接和目录重解析点（junction），避免循环和重复统计；
//! * Unix 上按 `(dev, ino)` 去重硬链接，只对 `nlink > 1` 的文件加锁。

use crate::engine::{ScanOptions, ScanProgress};
use crate::tree::{FlatTree, FLAG_DIR, FLAG_UNREADABLE, NONE};
use rayon::prelude::*;
use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

struct RawFile {
    name: Box<str>,
    size: u64,
    modified: u32,
}

struct RawDir {
    name: Box<str>,
    modified: u32,
    unreadable: bool,
    files: Vec<RawFile>,
    dirs: Vec<RawDir>,
}

struct Ctx<'a> {
    progress: &'a ScanProgress,
    root_device: Option<u64>,
    same_filesystem: bool,
    allocated_size: bool,
    seen_hardlinks: Mutex<HashSet<(u64, u64)>>,
}

impl Ctx<'_> {
    fn file_size(&self, meta: &Metadata) -> u64 {
        if self.allocated_size {
            platform::allocated_size(meta)
        } else {
            meta.len()
        }
    }

    /// 硬链接只统计第一次出现。
    fn first_sighting(&self, meta: &Metadata) -> bool {
        match platform::hardlink_key(meta) {
            None => true,
            Some(key) => self.seen_hardlinks.lock().map(|mut seen| seen.insert(key)).unwrap_or(true),
        }
    }

    fn crosses_device(&self, meta: &Metadata) -> bool {
        self.same_filesystem
            && matches!((self.root_device, platform::device_id(meta)), (Some(a), Some(b)) if a != b)
    }
}

/// 并行扫描 `root`，返回已 `finalize` 的扁平树。
pub fn walk(root: &Path, opts: &ScanOptions, progress: &ScanProgress) -> io::Result<FlatTree> {
    let meta = fs::metadata(root)?;
    if !meta.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} 不是目录", root.display())));
    }

    let ctx = Ctx {
        progress,
        root_device: platform::device_id(&meta),
        same_filesystem: opts.same_filesystem,
        allocated_size: opts.allocated_size,
        seen_hardlinks: Mutex::new(HashSet::new()),
    };

    // 独立线程池：可控线程数，并给深层目录递归留足栈空间
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(opts.threads)
        .stack_size(16 << 20)
        .thread_name(|i| format!("disklens-walk-{i}"))
        .build()
        .map_err(|e| io::Error::other(e.to_string()))?;

    let root_name: Box<str> = root.to_string_lossy().into();
    let raw = pool.install(|| scan_dir(root, root_name, unix_secs(&meta), &ctx));

    let capacity = (progress.files.load(Relaxed) + progress.dirs.load(Relaxed)) as usize;
    Ok(flatten(raw, root, capacity))
}

fn scan_dir(path: &Path, name: Box<str>, modified: u32, ctx: &Ctx) -> RawDir {
    let mut dir = RawDir { name, modified, unreadable: false, files: Vec::new(), dirs: Vec::new() };
    if ctx.progress.is_cancelled() {
        return dir;
    }

    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => {
            dir.unreadable = true;
            ctx.progress.errors.fetch_add(1, Relaxed);
            return dir;
        }
    };

    let mut subdirs: Vec<(PathBuf, Box<str>, u32)> = Vec::new();
    let mut bytes = 0u64;

    for entry in entries {
        let Ok(entry) = entry else {
            ctx.progress.errors.fetch_add(1, Relaxed);
            continue;
        };
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            ctx.progress.errors.fetch_add(1, Relaxed);
            continue;
        };

        let entry_name: Box<str> = entry.file_name().to_string_lossy().into();
        let mtime = unix_secs(&meta);

        if file_type.is_dir() {
            // 目录 junction / 挂载点：跳过，避免循环和重复统计。
            // 文件类重解析点（如 OneDrive 占位文件）仍然计入。
            if platform::is_reparse_point(&meta) || ctx.crosses_device(&meta) {
                continue;
            }
            subdirs.push((entry.path(), entry_name, mtime));
        } else if ctx.first_sighting(&meta) {
            let size = ctx.file_size(&meta);
            bytes += size;
            dir.files.push(RawFile { name: entry_name, size, modified: mtime });
        }
    }

    // 批量更新进度：每个目录只做几次原子操作
    let progress = ctx.progress;
    progress.files.fetch_add(dir.files.len() as u64, Relaxed);
    progress.bytes.fetch_add(bytes, Relaxed);
    if progress.dirs.fetch_add(1, Relaxed) % 128 == 0 {
        progress.set_current(&path.to_string_lossy());
    }
    dir.files.shrink_to_fit();

    // 子目录并行递归，rayon 负责工作窃取
    dir.dirs = subdirs
        .into_par_iter()
        .map(|(child, child_name, mtime)| scan_dir(&child, child_name, mtime, ctx))
        .collect();
    dir
}

/// 显式栈扁平化：父节点总是先于子节点入树，满足 `FlatTree` 的下标约定。
fn flatten(root: RawDir, root_path: &Path, capacity: usize) -> FlatTree {
    let mut tree = FlatTree::with_capacity(capacity.max(1), capacity.saturating_mul(16));
    tree.set_root_path(root_path.to_string_lossy().into_owned());

    let mut stack: Vec<(RawDir, u32)> = vec![(root, NONE)];
    while let Some((dir, parent)) = stack.pop() {
        let RawDir { name, modified, unreadable, files, dirs } = dir;
        let flags = FLAG_DIR | if unreadable { FLAG_UNREADABLE } else { 0 };
        let id = tree.push(parent, &name, 0, modified, flags);
        for file in files {
            tree.push(id, &file.name, file.size, file.modified, 0);
        }
        stack.extend(dirs.into_iter().map(|child| (child, id)));
    }

    tree.finalize();
    tree
}

fn unix_secs(meta: &Metadata) -> u32 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs().min(u32::MAX as u64) as u32)
        .unwrap_or(0)
}

#[cfg(windows)]
mod platform {
    use std::fs::Metadata;
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    pub fn is_reparse_point(meta: &Metadata) -> bool {
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    pub fn device_id(_meta: &Metadata) -> Option<u64> {
        None
    }

    /// Windows 上获取文件 ID 需要额外打开文件，代价太高；硬链接交给 MFT 模式处理。
    pub fn hardlink_key(_meta: &Metadata) -> Option<(u64, u64)> {
        None
    }

    pub fn allocated_size(meta: &Metadata) -> u64 {
        meta.len()
    }
}

#[cfg(unix)]
mod platform {
    use std::fs::Metadata;
    use std::os::unix::fs::MetadataExt;

    pub fn is_reparse_point(_meta: &Metadata) -> bool {
        false
    }

    pub fn device_id(meta: &Metadata) -> Option<u64> {
        Some(meta.dev())
    }

    pub fn hardlink_key(meta: &Metadata) -> Option<(u64, u64)> {
        (meta.nlink() > 1).then(|| (meta.dev(), meta.ino()))
    }

    pub fn allocated_size(meta: &Metadata) -> u64 {
        meta.blocks() * 512
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    use std::fs::Metadata;

    pub fn is_reparse_point(_meta: &Metadata) -> bool {
        false
    }

    pub fn device_id(_meta: &Metadata) -> Option<u64> {
        None
    }

    pub fn hardlink_key(_meta: &Metadata) -> Option<(u64, u64)> {
        None
    }

    pub fn allocated_size(meta: &Metadata) -> u64 {
        meta.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, ScanOptions};

    #[test]
    fn walks_a_temp_directory() {
        let root = std::env::temp_dir().join(format!("disklens-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("sub/deeper")).unwrap();
        fs::write(root.join("a.bin"), vec![0u8; 1000]).unwrap();
        fs::write(root.join("sub/b.txt"), vec![0u8; 300]).unwrap();
        fs::write(root.join("sub/deeper/c.txt"), vec![0u8; 200]).unwrap();

        let progress = ScanProgress::default();
        let opts = ScanOptions { engine: Engine::Walk, threads: 2, ..ScanOptions::default() };
        let tree = walk(&root, &opts, &progress).unwrap();

        assert_eq!(tree.node(0).size, 1500);
        assert_eq!(tree.node(0).file_count, 3);
        let first = tree.children(0).next().unwrap();
        assert_eq!(tree.name(first), "a.bin");
        fs::remove_dir_all(&root).unwrap();
    }
}
