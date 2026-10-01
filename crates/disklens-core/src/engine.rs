//! 扫描入口：选择引擎、提供进度计数器、统一返回结果。
//!
//! * [`Engine::Auto`]：Windows 上扫描整个卷（如 `C:\`）时先尝试 NTFS `$MFT` 直读，
//!   失败（没有管理员权限、不是 NTFS……）就回退到并行遍历；
//! * [`Engine::Walk`]：总是使用 rayon 并行遍历，所有平台、所有文件系统都能用；
//! * [`Engine::Mft`]：只使用 `$MFT`，失败时直接报错。
//!
//! 进度统一用原子计数器：扫描线程按目录（或按 4MB 块）批量累加，
//! UI 线程每 100ms 读一次 [`ScanProgress::snapshot`]，扫描线程永远不会被 UI 阻塞。

use crate::tree::FlatTree;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Auto,
    Walk,
    Mft,
}

impl Engine {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "walk" | "rayon" | "parallel" => Engine::Walk,
            "mft" | "ntfs" => Engine::Mft,
            _ => Engine::Auto,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Engine::Auto => "auto",
            Engine::Walk => "walk (rayon 并行遍历)",
            Engine::Mft => "mft (NTFS 元数据直读)",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub engine: Engine,
    /// 线程数，0 表示使用全部逻辑核心。
    pub threads: usize,
    /// 遍历模式下不跨越挂载点（Unix 按设备号判断；Windows 靠跳过重解析点）。
    pub same_filesystem: bool,
    /// 统计磁盘实际占用（Unix: `st_blocks * 512`）而不是逻辑大小。
    pub allocated_size: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self { engine: Engine::Auto, threads: 0, same_filesystem: true, allocated_size: false }
    }
}

/// 扫描线程与 UI 线程共享的进度状态。
#[derive(Default, Debug)]
pub struct ScanProgress {
    pub cancel: AtomicBool,
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    /// MFT 模式：已读取 / 总记录数。
    pub records_done: AtomicU64,
    pub records_total: AtomicU64,
    current: Mutex<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSnapshot {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub errors: u64,
    pub records_done: u64,
    pub records_total: u64,
    pub current_path: String,
}

impl ScanProgress {
    pub fn cancel(&self) {
        self.cancel.store(true, Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Relaxed)
    }

    /// 记录当前路径。用 `try_lock`，拿不到锁就跳过，绝不让扫描线程等待。
    pub fn set_current(&self, path: &str) {
        if let Ok(mut current) = self.current.try_lock() {
            current.clear();
            current.push_str(path);
        }
    }

    pub fn snapshot(&self) -> ProgressSnapshot {
        ProgressSnapshot {
            files: self.files.load(Relaxed),
            dirs: self.dirs.load(Relaxed),
            bytes: self.bytes.load(Relaxed),
            errors: self.errors.load(Relaxed),
            records_done: self.records_done.load(Relaxed),
            records_total: self.records_total.load(Relaxed),
            current_path: self.current.lock().map(|s| s.clone()).unwrap_or_default(),
        }
    }

    fn reset_counters(&self) {
        for counter in [&self.files, &self.dirs, &self.bytes, &self.errors, &self.records_done, &self.records_total] {
            counter.store(0, Relaxed);
        }
    }
}

pub struct ScanOutcome {
    pub tree: FlatTree,
    pub engine_used: Engine,
    pub elapsed: Duration,
    /// Auto 模式下 MFT 不可用时的原因说明。
    pub fallback_reason: Option<String>,
    /// 被取消时为 true，`tree` 是已扫描部分的结果。
    pub cancelled: bool,
}

/// 扫描 `root`。阻塞调用，请在后台线程中运行（建议栈大小 ≥ 16MB）。
pub fn scan(root: &Path, opts: &ScanOptions, progress: &ScanProgress) -> io::Result<ScanOutcome> {
    let started = Instant::now();

    let fallback_reason = match try_mft(root, opts, progress)? {
        MftAttempt::Done(tree) => {
            return Ok(ScanOutcome {
                tree,
                engine_used: Engine::Mft,
                elapsed: started.elapsed(),
                fallback_reason: None,
                cancelled: false,
            });
        }
        MftAttempt::Skipped(reason) => reason,
    };

    let tree = crate::scanner::walk(root, opts, progress)?;
    Ok(ScanOutcome {
        tree,
        engine_used: Engine::Walk,
        elapsed: started.elapsed(),
        fallback_reason,
        cancelled: progress.is_cancelled(),
    })
}

enum MftAttempt {
    Done(FlatTree),
    Skipped(Option<String>),
}

#[cfg(windows)]
fn try_mft(root: &Path, opts: &ScanOptions, progress: &ScanProgress) -> io::Result<MftAttempt> {
    if opts.engine == Engine::Walk {
        return Ok(MftAttempt::Skipped(None));
    }
    let Some(letter) = crate::mft::drive_root_letter(root) else {
        return if opts.engine == Engine::Mft {
            Err(io::Error::new(io::ErrorKind::InvalidInput, "MFT 模式只能扫描整个卷，例如 C:\\"))
        } else {
            Ok(MftAttempt::Skipped(None))
        };
    };
    match crate::mft::scan_volume(letter, progress) {
        Ok(tree) => Ok(MftAttempt::Done(tree)),
        Err(e) if e.kind() == io::ErrorKind::Interrupted || opts.engine == Engine::Mft => Err(e),
        Err(e) => {
            progress.reset_counters();
            Ok(MftAttempt::Skipped(Some(format!("MFT 模式不可用（{e}），已回退到并行遍历"))))
        }
    }
}

#[cfg(not(windows))]
fn try_mft(_root: &Path, opts: &ScanOptions, progress: &ScanProgress) -> io::Result<MftAttempt> {
    if opts.engine == Engine::Mft {
        return Err(io::Error::new(io::ErrorKind::Unsupported, "MFT 模式仅支持 Windows NTFS"));
    }
    progress.reset_counters();
    Ok(MftAttempt::Skipped(None))
}
