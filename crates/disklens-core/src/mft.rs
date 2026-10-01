//! NTFS `$MFT` 直读（WizTree 的做法）。
//!
//! NTFS 把卷上所有文件的元数据都放在 `$MFT` 里。顺序读取它，就不需要逐个打开目录，
//! 百万文件通常 1~3 秒即可完成：
//!
//! 1. 以管理员身份打开 `\\.\C:`；
//! 2. 读引导扇区，得到簇大小、`$MFT` 起始簇、记录大小；
//! 3. 读第 0 条记录（`$MFT` 自身），解析其 `$DATA` 的 data runs，得到 MFT 的所有片段；
//! 4. 按 4MB 大块顺序读取片段，每块内的 FILE 记录用 rayon **并行解析**：
//!    * `$STANDARD_INFORMATION (0x10)`：修改时间
//!    * `$FILE_NAME (0x30)`：文件名 + 父目录记录号（优先 Win32 命名空间，跳过 8.3 短名）
//!    * `$DATA (0x80)`：未命名数据流的大小（常驻 / 非常驻）
//! 5. 按父记录号做计数排序建立子节点表，从根目录（记录 #5）BFS 建树；
//! 6. [`FlatTree::finalize`] 自底向上汇总大小。
//!
//! 解析逻辑与平台无关，[`scan_reader`] 可以直接读取 NTFS 磁盘镜像文件做测试；
//! 只有 [`scan_volume`]（打开物理卷）是 Windows 专用。
//!
//! 已处理：更新序列（fixup）、碎片化的 `$MFT`、扩展记录（`$ATTRIBUTE_LIST` 指向的
//! 记录中的 `$DATA`）、硬链接（每个文件只挂在一个父目录下，只统计一次）、稀疏运行。
//! 未处理：命名数据流（ADS）、簇小于记录大小的卷（会报错并由上层回退到遍历模式）。

use crate::engine::ScanProgress;
use crate::tree::{FlatTree, FLAG_DIR, NONE};
use rayon::prelude::*;
use std::collections::VecDeque;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::Ordering::Relaxed;

const ROOT_RECORD: usize = 5;
const REF_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;

const ATTR_STANDARD_INFORMATION: u32 = 0x10;
const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_DATA: u32 = 0x80;
const ATTR_END: u32 = 0xFFFF_FFFF;

const RECORD_IN_USE: u16 = 0x0001;
const RECORD_IS_DIRECTORY: u16 = 0x0002;

/// 引导扇区 / 第 0 条记录读取时的对齐单位（兼容 4Kn 硬盘）。
const ALIGN: usize = 4096;
/// 顺序读取块大小。
const READ_CHUNK: usize = 4 << 20;

#[derive(Debug, Clone, Copy)]
struct Geometry {
    cluster_size: u64,
    mft_offset: u64,
    record_size: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Run {
    /// `None` 表示稀疏运行（没有分配磁盘空间）。
    lcn: Option<u64>,
    clusters: u64,
}

/// 单条记录的解析结果（并行阶段产出，串行阶段合并）。
#[derive(Default)]
struct Parsed {
    /// 属性归属的记录：基本记录为自身，扩展记录为其基本记录。
    target: u64,
    is_base: bool,
    is_dir: bool,
    /// (命名空间优先级, 父记录号, 名字)
    name: Option<(u8, u64, Box<str>)>,
    size: Option<u64>,
    modified: Option<u32>,
}

/// 按记录号索引的汇总信息。
#[derive(Clone, Default)]
struct Entry {
    parent: u64,
    name: Option<Box<str>>,
    name_rank: u8,
    size: u64,
    modified: u32,
    in_use: bool,
    is_dir: bool,
}

/// 如果 `path` 是卷根目录（`C:\`、`C:`），返回盘符。
pub fn drive_root_letter(path: &Path) -> Option<char> {
    let text = path.to_str()?;
    let trimmed = text.trim_end_matches(|c| c == '\\' || c == '/');
    let bytes = trimmed.as_bytes();
    (bytes.len() == 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()).then(|| bytes[0] as char)
}

/// 打开 `\\.\X:` 并扫描整个卷。需要管理员权限。
#[cfg(windows)]
pub fn scan_volume(letter: char, progress: &ScanProgress) -> io::Result<FlatTree> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;

    let letter = letter.to_ascii_uppercase();
    let device = format!(r"\\.\{letter}:");
    let volume = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&device)
        .map_err(|e| match e.kind() {
            io::ErrorKind::PermissionDenied => io::Error::new(e.kind(), "读取 $MFT 需要以管理员身份运行"),
            _ => e,
        })?;
    scan_reader(volume, &format!("{letter}:\\"), progress)
}

/// 从任意 NTFS 数据源（物理卷或磁盘镜像）读取 `$MFT` 并建树。
pub fn scan_reader<R: Read + Seek>(mut dev: R, root_path: &str, progress: &ScanProgress) -> io::Result<FlatTree> {
    // 1. 引导扇区
    let mut boot = vec![0u8; ALIGN];
    dev.seek(SeekFrom::Start(0))?;
    dev.read_exact(&mut boot)?;
    let geo = parse_boot(&boot)?;
    if geo.cluster_size < geo.record_size as u64 {
        return Err(io::Error::new(io::ErrorKind::Unsupported, "簇小于 MFT 记录大小的卷暂不支持"));
    }

    // 2. 第 0 条记录：$MFT 自身，从中得到 MFT 的全部片段
    let mut first = vec![0u8; align_up(geo.record_size, ALIGN)];
    dev.seek(SeekFrom::Start(geo.mft_offset))?;
    dev.read_exact(&mut first)?;
    let record0 = &mut first[..geo.record_size];
    if !apply_fixup(record0) || &record0[0..4] != b"FILE" {
        return Err(invalid("$MFT 第 0 条记录损坏"));
    }
    let (mft_bytes, runs) = mft_layout(record0).ok_or_else(|| invalid("无法定位 $MFT 的数据区"))?;

    let total = mft_bytes / geo.record_size as u64;
    progress.records_total.store(total, Relaxed);
    let mut entries = vec![Entry::default(); total as usize];

    // 3. 大块顺序读取 + 块内并行解析
    let chunk_cap = (READ_CHUNK - READ_CHUNK % geo.cluster_size as usize).max(geo.cluster_size as usize);
    let mut buf = vec![0u8; chunk_cap];
    let mut record_no = 0u64;

    for run in &runs {
        if record_no >= total {
            break;
        }
        let run_bytes = run.clusters * geo.cluster_size;
        let Some(lcn) = run.lcn else {
            record_no += run_bytes / geo.record_size as u64;
            continue;
        };

        dev.seek(SeekFrom::Start(lcn * geo.cluster_size))?;
        let mut done = 0u64;
        while done < run_bytes && record_no < total {
            if progress.is_cancelled() {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "扫描已取消"));
            }
            let want = (run_bytes - done).min(chunk_cap as u64) as usize;
            let chunk = &mut buf[..want];
            dev.read_exact(chunk)?;

            let first_no = record_no;
            let parsed: Vec<Parsed> = chunk
                .par_chunks_exact_mut(geo.record_size)
                .enumerate()
                .filter_map(|(i, record)| {
                    let no = first_no + i as u64;
                    if no >= total || !apply_fixup(record) {
                        return None;
                    }
                    parse_record(record, no)
                })
                .collect();
            for item in parsed {
                merge(&mut entries, item);
            }

            record_no += (want / geo.record_size) as u64;
            done += want as u64;
            progress.records_done.store(record_no.min(total), Relaxed);
        }
    }

    // 4. 建树
    build_tree(&entries, root_path, progress)
}

fn parse_boot(boot: &[u8]) -> io::Result<Geometry> {
    if boot.len() < 512 || &boot[3..11] != b"NTFS    " {
        return Err(invalid("不是 NTFS 卷"));
    }
    let bytes_per_sector = rd_u16(boot, 0x0B) as u64;
    let raw_spc = boot[0x0D];
    // 大簇（≥ 64KB）时该字段是负指数：2^(256 - x)
    let sectors_per_cluster: u64 = if raw_spc <= 0x80 { raw_spc as u64 } else { 1u64 << (256 - raw_spc as u32) };
    let cluster_size = bytes_per_sector * sectors_per_cluster;
    let mft_lcn = rd_u64(boot, 0x30);
    let clusters_per_record = boot[0x40] as i8;
    let record_size = if clusters_per_record > 0 {
        clusters_per_record as u64 * cluster_size
    } else {
        1u64 << (-(clusters_per_record as i32)) as u32
    };

    if !(256..=4096).contains(&bytes_per_sector) || cluster_size == 0 || !(256..=65536).contains(&record_size) {
        return Err(invalid("NTFS 引导扇区参数异常"));
    }
    Ok(Geometry { cluster_size, mft_offset: mft_lcn * cluster_size, record_size: record_size as usize })
}

/// 应用更新序列（fixup）：每 512 字节末尾两字节被替换成了校验值，需要还原。
/// 校验失败（写入被撕裂）时返回 false。
fn apply_fixup(record: &mut [u8]) -> bool {
    if record.len() < 48 || &record[0..4] != b"FILE" {
        return false;
    }
    let usa_offset = rd_u16(record, 4) as usize;
    let usa_count = rd_u16(record, 6) as usize;
    if usa_count < 2 || usa_offset + usa_count * 2 > record.len() {
        return false;
    }
    let check = [record[usa_offset], record[usa_offset + 1]];
    for i in 1..usa_count {
        let pos = i * 512 - 2;
        if pos + 2 > record.len() {
            break;
        }
        if record[pos] != check[0] || record[pos + 1] != check[1] {
            return false;
        }
        record[pos] = record[usa_offset + i * 2];
        record[pos + 1] = record[usa_offset + i * 2 + 1];
    }
    true
}

/// 从 `$MFT` 自身的记录中取出 MFT 总字节数与 data runs。
fn mft_layout(record: &[u8]) -> Option<(u64, Vec<Run>)> {
    for (kind, attr) in attributes(record) {
        let non_resident = attr[8] != 0;
        let name_len = attr[9];
        if kind == ATTR_DATA && non_resident && name_len == 0 {
            let runs_offset = rd_u16(attr, 32) as usize;
            return Some((rd_u64(attr, 48), parse_runs(attr.get(runs_offset..)?)));
        }
    }
    None
}

/// 解码 data runs：每项头字节低 4 位是长度字段字节数，高 4 位是偏移字段字节数；
/// 偏移是相对上一项 LCN 的有符号数，偏移字节数为 0 表示稀疏。
fn parse_runs(bytes: &[u8]) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut pos = 0usize;
    let mut lcn: i64 = 0;
    while pos < bytes.len() {
        let header = bytes[pos];
        if header == 0 {
            break;
        }
        let len_size = (header & 0x0F) as usize;
        let off_size = (header >> 4) as usize;
        pos += 1;
        if len_size == 0 || len_size > 8 || off_size > 8 || pos + len_size + off_size > bytes.len() {
            break;
        }

        let mut clusters = 0u64;
        for i in 0..len_size {
            clusters |= (bytes[pos + i] as u64) << (8 * i);
        }
        pos += len_size;

        if off_size == 0 {
            runs.push(Run { lcn: None, clusters });
            continue;
        }
        let mut delta = 0i64;
        for i in 0..off_size {
            delta |= (bytes[pos + i] as i64) << (8 * i);
        }
        let shift = 64 - 8 * off_size as u32;
        delta = (delta << shift) >> shift; // 符号扩展
        pos += off_size;

        lcn += delta;
        runs.push(Run { lcn: (lcn >= 0).then_some(lcn as u64), clusters });
    }
    runs
}

fn parse_record(record: &[u8], record_no: u64) -> Option<Parsed> {
    let flags = rd_u16(record, 22);
    if flags & RECORD_IN_USE == 0 {
        return None;
    }
    let base = rd_u64(record, 32) & REF_MASK;
    let mut out = Parsed {
        target: if base == 0 { record_no } else { base },
        is_base: base == 0,
        is_dir: flags & RECORD_IS_DIRECTORY != 0,
        ..Parsed::default()
    };

    for (kind, attr) in attributes(record) {
        let non_resident = attr[8] != 0;
        let name_len = attr[9];
        match kind {
            ATTR_STANDARD_INFORMATION if !non_resident => {
                let value = resident_value(attr);
                if value.len() >= 16 {
                    out.modified = Some(filetime_to_unix(rd_u64(value, 8)));
                }
            }
            ATTR_FILE_NAME if !non_resident => {
                let value = resident_value(attr);
                if value.len() < 66 {
                    continue;
                }
                let chars = value[64] as usize;
                let rank = namespace_rank(value[65]);
                let better = out.name.as_ref().map_or(true, |(current, _, _)| rank > *current);
                if better && 66 + chars * 2 <= value.len() {
                    let units: Vec<u16> = value[66..66 + chars * 2]
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    let parent = rd_u64(value, 0) & REF_MASK;
                    out.name = Some((rank, parent, String::from_utf16_lossy(&units).into_boxed_str()));
                }
            }
            ATTR_DATA if name_len == 0 => {
                if non_resident {
                    // 只有 lowest_vcn == 0 的片段携带真实大小
                    if rd_u64(attr, 16) == 0 {
                        out.size = Some(rd_u64(attr, 48));
                    }
                } else {
                    out.size = Some(rd_u32(attr, 16) as u64);
                }
            }
            _ => {}
        }
    }
    Some(out)
}

fn merge(entries: &mut [Entry], item: Parsed) {
    let Some(entry) = entries.get_mut(item.target as usize) else { return };
    if item.is_base {
        entry.in_use = true;
        entry.is_dir = item.is_dir;
    }
    if let Some((rank, parent, name)) = item.name {
        if entry.name.is_none() || rank > entry.name_rank {
            entry.name = Some(name);
            entry.parent = parent;
            entry.name_rank = rank;
        }
    }
    if let Some(size) = item.size {
        entry.size = size;
    }
    if let Some(modified) = item.modified {
        entry.modified = modified;
    }
}

fn build_tree(entries: &[Entry], root_path: &str, progress: &ScanProgress) -> io::Result<FlatTree> {
    let n = entries.len();
    if n <= ROOT_RECORD || !entries[ROOT_RECORD].in_use {
        return Err(invalid("根目录记录 (#5) 无效"));
    }

    // 有效的「子 → 父」关系：父记录存在、在用、是目录；根目录自身排除（它的父是自己）
    let parent_of = |r: usize| -> Option<usize> {
        let e = &entries[r];
        if r == ROOT_RECORD || !e.in_use || e.name.is_none() {
            return None;
        }
        let p = e.parent as usize;
        (p < n && p != r && entries[p].in_use && entries[p].is_dir).then_some(p)
    };

    // 计数排序建立子节点表（CSR）
    let mut start = vec![0u32; n + 1];
    for r in 0..n {
        if let Some(p) = parent_of(r) {
            start[p + 1] += 1;
        }
    }
    for i in 0..n {
        start[i + 1] += start[i];
    }
    let mut fill = start.clone();
    let mut kids = vec![0u32; start[n] as usize];
    for r in 0..n {
        if let Some(p) = parent_of(r) {
            kids[fill[p] as usize] = r as u32;
            fill[p] += 1;
        }
    }
    drop(fill);

    // 从根目录 BFS：每条记录只有一个父节点，所以最多访问一次，不会因损坏数据死循环
    let linked = start[n] as usize;
    let mut tree = FlatTree::with_capacity(linked + 1, linked * 20);
    tree.set_root_path(root_path);
    let root_id = tree.push(NONE, root_path, 0, entries[ROOT_RECORD].modified, FLAG_DIR);

    let (mut files, mut dirs, mut bytes) = (0u64, 1u64, 0u64);
    let mut queue = VecDeque::from([(ROOT_RECORD, root_id)]);
    while let Some((record, id)) = queue.pop_front() {
        for &child in &kids[start[record] as usize..start[record + 1] as usize] {
            let entry = &entries[child as usize];
            let name = entry.name.as_deref().unwrap_or("?");
            if entry.is_dir {
                let child_id = tree.push(id, name, 0, entry.modified, FLAG_DIR);
                queue.push_back((child as usize, child_id));
                dirs += 1;
            } else {
                tree.push(id, name, entry.size, entry.modified, 0);
                files += 1;
                bytes += entry.size;
            }
        }
    }

    progress.files.store(files, Relaxed);
    progress.dirs.store(dirs, Relaxed);
    progress.bytes.store(bytes, Relaxed);
    tree.finalize();
    Ok(tree)
}

/// 遍历一条 FILE 记录中的属性：`(类型, 属性原始字节)`。
struct AttrIter<'a> {
    record: &'a [u8],
    offset: usize,
    end: usize,
}

fn attributes(record: &[u8]) -> AttrIter<'_> {
    AttrIter {
        record,
        offset: rd_u16(record, 20) as usize,
        end: (rd_u32(record, 24) as usize).min(record.len()),
    }
}

impl<'a> Iterator for AttrIter<'a> {
    type Item = (u32, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        if self.offset + 16 > self.end {
            return None;
        }
        let kind = rd_u32(self.record, self.offset);
        let len = rd_u32(self.record, self.offset + 4) as usize;
        if kind == ATTR_END || len < 16 || self.offset + len > self.end {
            self.offset = self.end;
            return None;
        }
        let attr = &self.record[self.offset..self.offset + len];
        self.offset += len;
        Some((kind, attr))
    }
}

fn resident_value(attr: &[u8]) -> &[u8] {
    let len = rd_u32(attr, 16) as usize;
    let offset = rd_u16(attr, 20) as usize;
    attr.get(offset..offset.saturating_add(len)).unwrap_or(&[])
}

/// Win32 / Win32+DOS 优先，其次 POSIX，最后才是 8.3 短名。
fn namespace_rank(namespace: u8) -> u8 {
    match namespace {
        1 | 3 => 3,
        0 => 2,
        2 => 1,
        _ => 0,
    }
}

fn filetime_to_unix(filetime: u64) -> u32 {
    (filetime / 10_000_000).saturating_sub(11_644_473_600).min(u32::MAX as u64) as u32
}

fn align_up(value: usize, align: usize) -> usize {
    value.div_ceil(align) * align
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn rd_u16(b: &[u8], o: usize) -> u16 {
    b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).unwrap_or(0)
}

fn rd_u32(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).unwrap_or(0)
}

fn rd_u64(b: &[u8], o: usize) -> u64 {
    b.get(o..o + 8)
        .map(|s| u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_data_runs() {
        // 24 簇 @ LCN 0x5634；5 簇稀疏；16 簇 @ 相对偏移 -16
        let bytes = [0x21, 0x18, 0x34, 0x56, 0x01, 0x05, 0x11, 0x10, 0xF0, 0x00];
        let runs = parse_runs(&bytes);
        assert_eq!(
            runs,
            vec![
                Run { lcn: Some(0x5634), clusters: 24 },
                Run { lcn: None, clusters: 5 },
                Run { lcn: Some(0x5634 - 16), clusters: 16 },
            ]
        );
    }

    #[test]
    fn detects_drive_roots() {
        assert_eq!(drive_root_letter(Path::new("C:\\")), Some('C'));
        assert_eq!(drive_root_letter(Path::new("d:")), Some('d'));
        assert_eq!(drive_root_letter(Path::new("C:\\Users")), None);
    }

    #[test]
    fn filetime_conversion() {
        // 2020-01-01T00:00:00Z
        assert_eq!(filetime_to_unix(132_223_104_000_000_000), 1_577_836_800);
    }
}
