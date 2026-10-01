//! 扁平化目录树。
//!
//! 千万级文件时，`Vec<Node>` 嵌套结构的每个节点都有一次 `String` + 一次 `Vec` 堆分配，
//! 内存会超过 1GB，而且指针跳转对 CPU 缓存很不友好。这里改为：
//!
//! * 所有节点放在一个 `Vec<FlatNode>` 里，用 `u32` 下标代替指针；
//! * 子节点用 `first_child` / `next_sibling` 串成单链表，并且**按大小降序链接**，
//!   UI 取「最大的 N 个子项」时不用再排序；
//! * 所有名字拼接进同一个 `Vec<u8>`，节点只记录偏移和长度。
//!
//! 约定：节点必须**先插父、后插子**（父下标 < 子下标），这样 [`FlatTree::finalize`]
//! 倒序扫描一遍就能自底向上汇总目录大小，不需要递归。

use rayon::prelude::*;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::PathBuf;

/// 表示「没有节点」的下标。
pub const NONE: u32 = u32::MAX;

pub const FLAG_DIR: u16 = 1 << 0;
pub const FLAG_DELETED: u16 = 1 << 1;
/// 目录无法读取（权限不足、已被删除等），大小可能偏小。
pub const FLAG_UNREADABLE: u16 = 1 << 2;

/// 单个节点，严格 40 字节。
#[derive(Clone, Copy, Debug)]
#[repr(C)]
pub struct FlatNode {
    /// 文件：逻辑大小；目录：子树总大小（`finalize` 之后有效）。
    pub size: u64,
    pub parent: u32,
    pub first_child: u32,
    pub next_sibling: u32,
    pub name_offset: u32,
    /// 文件为 1；目录为子树内的文件总数。
    pub file_count: u32,
    /// 修改时间（Unix 秒，u32 可用到 2106 年）。
    pub modified: u32,
    pub name_len: u16,
    pub flags: u16,
}

const _: () = assert!(std::mem::size_of::<FlatNode>() == 40);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtStat {
    /// 小写扩展名，不含点；没有扩展名时为空字符串。
    pub ext: String,
    pub size: u64,
    pub count: u64,
}

#[derive(Default, Debug)]
pub struct FlatTree {
    nodes: Vec<FlatNode>,
    names: Vec<u8>,
    root_path: String,
}

impl FlatTree {
    pub fn with_capacity(nodes: usize, name_bytes: usize) -> Self {
        Self {
            nodes: Vec::with_capacity(nodes),
            names: Vec::with_capacity(name_bytes),
            root_path: String::new(),
        }
    }

    pub fn set_root_path(&mut self, path: impl Into<String>) {
        self.root_path = path.into();
    }

    pub fn root_path(&self) -> &str {
        &self.root_path
    }

    /// 追加一个节点，返回它的下标。`parent` 必须已经存在（或为 [`NONE`] 表示根）。
    pub fn push(&mut self, parent: u32, name: &str, size: u64, modified: u32, flags: u16) -> u32 {
        let id = self.nodes.len() as u32;
        debug_assert!(parent == NONE || parent < id, "父节点必须先于子节点插入");

        // 名字超过 u16 时截断，并保证落在 UTF-8 字符边界上
        let mut len = name.len().min(u16::MAX as usize);
        while !name.is_char_boundary(len) {
            len -= 1;
        }
        let name_offset = self.names.len() as u32;
        self.names.extend_from_slice(&name.as_bytes()[..len]);

        let is_dir = flags & FLAG_DIR != 0;
        self.nodes.push(FlatNode {
            size: if is_dir { 0 } else { size },
            parent,
            first_child: NONE,
            next_sibling: NONE,
            name_offset,
            file_count: if is_dir { 0 } else { 1 },
            modified,
            name_len: len as u16,
            flags,
        });
        id
    }

    /// 插入完成后调用一次：自底向上汇总目录大小，并把子节点按大小降序串成链表。
    ///
    /// 复杂度 O(n) + 每个目录内部排序，全程不递归。可以重复调用。
    pub fn finalize(&mut self) {
        let n = self.nodes.len();
        if n == 0 {
            return;
        }

        // 1. 重置目录汇总值
        for node in &mut self.nodes {
            if node.flags & FLAG_DIR != 0 {
                node.size = 0;
                node.file_count = 0;
            }
            node.first_child = NONE;
            node.next_sibling = NONE;
        }

        // 2. 倒序累加：处理到 id 时，它的所有后代（下标都更大）已经加进它里面了
        for id in (1..n).rev() {
            let FlatNode { parent, size, file_count, flags, .. } = self.nodes[id];
            if flags & FLAG_DELETED != 0 || parent == NONE {
                continue;
            }
            let p = &mut self.nodes[parent as usize];
            p.size += size;
            p.file_count = p.file_count.saturating_add(file_count);
        }

        // 3. 按父节点做一次计数排序（CSR），得到每个目录的子节点区间
        let mut start = vec![0u32; n + 1];
        for id in 1..n {
            let node = &self.nodes[id];
            if node.parent != NONE && node.flags & FLAG_DELETED == 0 {
                start[node.parent as usize + 1] += 1;
            }
        }
        for i in 0..n {
            start[i + 1] += start[i];
        }
        let mut fill = start.clone();
        let mut order = vec![0u32; start[n] as usize];
        for id in 1..n {
            let node = &self.nodes[id];
            if node.parent != NONE && node.flags & FLAG_DELETED == 0 {
                let p = node.parent as usize;
                order[fill[p] as usize] = id as u32;
                fill[p] += 1;
            }
        }

        // 4. 每组按大小降序排列
        {
            let nodes = &self.nodes;
            for p in 0..n {
                let group = &mut order[start[p] as usize..start[p + 1] as usize];
                if group.len() > 1 {
                    group.sort_unstable_by(|&a, &b| nodes[b as usize].size.cmp(&nodes[a as usize].size));
                }
            }
        }

        // 5. 串成链表
        for p in 0..n {
            let group = &order[start[p] as usize..start[p + 1] as usize];
            if let Some(&first) = group.first() {
                self.nodes[p].first_child = first;
                for pair in group.windows(2) {
                    self.nodes[pair[0] as usize].next_sibling = pair[1];
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn contains(&self, id: u32) -> bool {
        (id as usize) < self.nodes.len()
    }

    pub fn nodes(&self) -> &[FlatNode] {
        &self.nodes
    }

    pub fn node(&self, id: u32) -> &FlatNode {
        &self.nodes[id as usize]
    }

    pub fn name(&self, id: u32) -> &str {
        let node = &self.nodes[id as usize];
        let start = node.name_offset as usize;
        let end = start + node.name_len as usize;
        // 名字都是从 &str 写入且按字符边界截断的，这里总是合法 UTF-8
        std::str::from_utf8(&self.names[start..end]).unwrap_or("\u{FFFD}")
    }

    pub fn is_dir(&self, id: u32) -> bool {
        self.nodes[id as usize].flags & FLAG_DIR != 0
    }

    pub fn is_deleted(&self, id: u32) -> bool {
        self.nodes[id as usize].flags & FLAG_DELETED != 0
    }

    pub fn dir_count(&self) -> u64 {
        self.nodes
            .iter()
            .filter(|n| n.flags & FLAG_DIR != 0 && n.flags & FLAG_DELETED == 0)
            .count() as u64
    }

    /// 按大小降序遍历直接子节点。
    pub fn children(&self, id: u32) -> Children<'_> {
        Children { tree: self, next: self.nodes[id as usize].first_child }
    }

    /// 节点的完整路径。
    pub fn path(&self, id: u32) -> PathBuf {
        let mut chain = Vec::new();
        let mut cur = id;
        while cur != NONE {
            chain.push(cur);
            cur = self.nodes[cur as usize].parent;
        }
        let mut path = PathBuf::from(&self.root_path);
        for &part in chain.iter().rev().skip(1) {
            path.push(self.name(part));
        }
        path
    }

    /// 结构体本身占用的堆内存（近似值）。
    pub fn memory_bytes(&self) -> usize {
        self.nodes.capacity() * std::mem::size_of::<FlatNode>() + self.names.capacity()
    }

    /// 删除一个子树（例如移到回收站之后），同步更新所有祖先的大小。
    /// 返回 `(释放字节数, 释放文件数)`；根节点、越界或已删除的节点返回 `None`。
    pub fn remove_subtree(&mut self, id: u32) -> Option<(u64, u32)> {
        if id == 0 || !self.contains(id) || self.is_deleted(id) {
            return None;
        }
        let FlatNode { size, file_count, parent, next_sibling, .. } = self.nodes[id as usize];

        // 标记整个子树
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            self.nodes[cur as usize].flags |= FLAG_DELETED;
            let mut child = self.nodes[cur as usize].first_child;
            while child != NONE {
                stack.push(child);
                child = self.nodes[child as usize].next_sibling;
            }
        }

        // 从父节点的兄弟链表中摘除
        if parent != NONE {
            if self.nodes[parent as usize].first_child == id {
                self.nodes[parent as usize].first_child = next_sibling;
            } else {
                let mut cur = self.nodes[parent as usize].first_child;
                while cur != NONE {
                    let next = self.nodes[cur as usize].next_sibling;
                    if next == id {
                        self.nodes[cur as usize].next_sibling = next_sibling;
                        break;
                    }
                    cur = next;
                }
            }
        }

        // 祖先减去对应大小
        let mut cur = parent;
        while cur != NONE {
            let node = &mut self.nodes[cur as usize];
            node.size = node.size.saturating_sub(size);
            node.file_count = node.file_count.saturating_sub(file_count);
            cur = node.parent;
        }
        Some((size, file_count))
    }

    /// 全盘最大的 `limit` 个文件（小顶堆，O(n log k)）。
    pub fn top_files(&self, limit: usize) -> Vec<u32> {
        if limit == 0 {
            return Vec::new();
        }
        let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::with_capacity(limit + 1);
        for (i, node) in self.nodes.iter().enumerate() {
            if node.flags & (FLAG_DIR | FLAG_DELETED) != 0 {
                continue;
            }
            if heap.len() < limit {
                heap.push(Reverse((node.size, i as u32)));
            } else if let Some(&Reverse((smallest, _))) = heap.peek() {
                if node.size > smallest {
                    heap.pop();
                    heap.push(Reverse((node.size, i as u32)));
                }
            }
        }
        let mut result: Vec<(u64, u32)> = heap.into_iter().map(|Reverse(item)| item).collect();
        result.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        result.into_iter().map(|(_, id)| id).collect()
    }

    /// 按扩展名汇总（并行 fold/reduce）。
    pub fn ext_stats(&self) -> Vec<ExtStat> {
        let map = (0..self.nodes.len())
            .into_par_iter()
            .filter(|&i| self.nodes[i].flags & (FLAG_DIR | FLAG_DELETED) == 0)
            .fold(HashMap::<String, (u64, u64)>::new, |mut acc, i| {
                let entry = acc.entry(ext_of(self.name(i as u32))).or_insert((0, 0));
                entry.0 += self.nodes[i].size;
                entry.1 += 1;
                acc
            })
            .reduce(HashMap::new, |mut a, b| {
                for (ext, (size, count)) in b {
                    let entry = a.entry(ext).or_insert((0, 0));
                    entry.0 += size;
                    entry.1 += count;
                }
                a
            });

        let mut stats: Vec<ExtStat> = map
            .into_iter()
            .map(|(ext, (size, count))| ExtStat { ext, size, count })
            .collect();
        stats.sort_unstable_by(|a, b| b.size.cmp(&a.size));
        stats
    }

    /// 文件名子串搜索（ASCII 不区分大小写），结果按大小降序。
    pub fn search(&self, needle: &str, limit: usize) -> Vec<u32> {
        let needle = needle.trim().trim_start_matches('*').to_ascii_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<u32> = (0..self.nodes.len() as u32)
            .into_par_iter()
            .filter(|&id| id != 0 && !self.is_deleted(id) && contains_ignore_ascii_case(self.name(id), &needle))
            .collect();
        hits.par_sort_unstable_by(|&a, &b| self.nodes[b as usize].size.cmp(&self.nodes[a as usize].size));
        hits.truncate(limit);
        hits
    }
}

pub struct Children<'a> {
    tree: &'a FlatTree,
    next: u32,
}

impl Iterator for Children<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        while self.next != NONE {
            let id = self.next;
            self.next = self.tree.nodes[id as usize].next_sibling;
            if !self.tree.is_deleted(id) {
                return Some(id);
            }
        }
        None
    }
}

/// 小写扩展名（不含点）。`.gitignore` 这类隐藏文件视为没有扩展名。
pub fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn contains_ignore_ascii_case(haystack: &str, needle_lower: &str) -> bool {
    let h = haystack.as_bytes();
    let n = needle_lower.as_bytes();
    if n.len() > h.len() {
        return false;
    }
    h.windows(n.len())
        .any(|w| w.iter().zip(n).all(|(a, b)| a.to_ascii_lowercase() == *b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> FlatTree {
        let mut t = FlatTree::default();
        t.set_root_path("C:\\");
        let root = t.push(NONE, "C:\\", 0, 0, FLAG_DIR);
        let a = t.push(root, "a", 0, 0, FLAG_DIR);
        t.push(root, "big.iso", 500, 0, 0);
        t.push(a, "x.txt", 100, 0, 0);
        t.push(a, "y.TXT", 300, 0, 0);
        t.finalize();
        t
    }

    #[test]
    fn aggregates_and_sorts_children() {
        let t = sample();
        assert_eq!(t.node(0).size, 900);
        assert_eq!(t.node(0).file_count, 3);
        assert_eq!(t.node(1).size, 400);
        let names: Vec<String> = t.children(0).map(|c| t.name(c).to_string()).collect();
        assert_eq!(names, ["big.iso", "a"]);
        let inner: Vec<String> = t.children(1).map(|c| t.name(c).to_string()).collect();
        assert_eq!(inner, ["y.TXT", "x.txt"]);
    }

    #[test]
    fn remove_subtree_updates_ancestors() {
        let mut t = sample();
        assert_eq!(t.remove_subtree(1), Some((400, 2)));
        assert_eq!(t.node(0).size, 500);
        assert_eq!(t.node(0).file_count, 1);
        assert_eq!(t.children(0).count(), 1);
        assert_eq!(t.remove_subtree(1), None);
    }

    #[test]
    fn queries() {
        let t = sample();
        let top: Vec<&str> = t.top_files(2).into_iter().map(|id| t.name(id)).collect();
        assert_eq!(top, ["big.iso", "y.TXT"]);
        let ext = t.ext_stats();
        assert_eq!(ext[0].ext, "iso");
        assert_eq!(ext[1].ext, "txt");
        assert_eq!(ext[1].count, 2);
        assert_eq!(t.search("*.txt", 10).len(), 2);
        assert!(t.path(3).ends_with("x.txt"));
    }
}
