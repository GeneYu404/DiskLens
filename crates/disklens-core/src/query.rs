//! 面向 UI 的查询：只返回界面需要显示的那一小部分数据。
//!
//! * [`children_page`]：懒加载目录树，一次只取一层、一页；
//! * [`top_files`] / [`search`]：Top-N 结果，带完整路径；
//! * [`export_snapshot`]：把「最大的 N 个节点」导出为紧凑二进制，
//!   较小的项合并成 `<其余 N 个文件>`（与矩形树图合并小块的思路一致），
//!   前端可以一次性拿到足够绘制树图和列表的数据，而传输量有上限。

use crate::tree::{FlatTree, FLAG_DIR, FLAG_UNREADABLE, NONE};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub const SNAPSHOT_MAGIC: &[u8; 4] = b"DLS1";
pub const SNAP_FLAG_DIR: u8 = 1 << 0;
pub const SNAP_FLAG_UNREADABLE: u8 = 1 << 1;
pub const SNAP_FLAG_SYNTHETIC: u8 = 1 << 2;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub file_count: u32,
    pub modified: u32,
    pub is_dir: bool,
    pub has_children: bool,
    pub unreadable: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u32,
    pub is_dir: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeSummary {
    pub root: String,
    pub nodes: usize,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub memory_bytes: usize,
}

pub fn node_info(tree: &FlatTree, id: u32) -> Option<NodeInfo> {
    if !tree.contains(id) {
        return None;
    }
    let node = tree.node(id);
    Some(NodeInfo {
        id,
        name: tree.name(id).to_string(),
        size: node.size,
        file_count: node.file_count,
        modified: node.modified,
        is_dir: node.flags & FLAG_DIR != 0,
        has_children: node.first_child != NONE,
        unreadable: node.flags & FLAG_UNREADABLE != 0,
    })
}

/// 某个目录的子项（已按大小降序），分页返回。
pub fn children_page(tree: &FlatTree, id: u32, offset: usize, limit: usize) -> Vec<NodeInfo> {
    if !tree.contains(id) {
        return Vec::new();
    }
    tree.children(id)
        .skip(offset)
        .take(limit)
        .filter_map(|child| node_info(tree, child))
        .collect()
}

fn hit(tree: &FlatTree, id: u32) -> FileHit {
    let node = tree.node(id);
    FileHit {
        id,
        name: tree.name(id).to_string(),
        path: tree.path(id).to_string_lossy().into_owned(),
        size: node.size,
        modified: node.modified,
        is_dir: node.flags & FLAG_DIR != 0,
    }
}

pub fn top_files(tree: &FlatTree, limit: usize) -> Vec<FileHit> {
    tree.top_files(limit).into_iter().map(|id| hit(tree, id)).collect()
}

pub fn search(tree: &FlatTree, query: &str, limit: usize) -> Vec<FileHit> {
    tree.search(query, limit).into_iter().map(|id| hit(tree, id)).collect()
}

pub fn summary(tree: &FlatTree) -> TreeSummary {
    let (files, bytes) = if tree.is_empty() {
        (0, 0)
    } else {
        (tree.node(0).file_count as u64, tree.node(0).size)
    };
    TreeSummary {
        root: tree.root_path().to_string(),
        nodes: tree.len(),
        files,
        dirs: tree.dir_count(),
        bytes,
        memory_bytes: tree.memory_bytes(),
    }
}

/// 导出剪枝快照。
///
/// 从根开始做「最大优先」扩展：堆里只放每个已选节点的第一个子节点和下一个兄弟
/// （子链表本身已按大小降序），因此堆大小始终是 O(已选节点数)。
/// 父节点一定先于子节点被选中，导出顺序天然满足「父下标 < 子下标」。
///
/// 格式（小端）：
/// ```text
/// magic "DLS1" | count: u32 |
/// 每个节点: src_id u32 | parent i32 | size f64 | file_count u32 | modified u32 |
///           flags u8 | name_len u16 | name UTF-8
/// ```
/// `src_id == u32::MAX` 表示合并出来的虚拟节点。
pub fn export_snapshot(tree: &FlatTree, max_nodes: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + max_nodes.min(tree.len()) * 48);
    out.extend_from_slice(SNAPSHOT_MAGIC);
    out.extend_from_slice(&0u32.to_le_bytes());
    if tree.is_empty() {
        return out;
    }

    let max_nodes = max_nodes.max(1);
    let mut picked: Vec<(u32, i32)> = Vec::with_capacity(max_nodes.min(tree.len()));
    let mut heap: BinaryHeap<(u64, Reverse<u32>, i32)> = BinaryHeap::new();
    heap.push((tree.node(0).size, Reverse(0), -1));

    while let Some((_, Reverse(id), parent)) = heap.pop() {
        if picked.len() >= max_nodes {
            break;
        }
        let index = picked.len() as i32;
        picked.push((id, parent));

        let node = tree.node(id);
        if node.first_child != NONE {
            heap.push((tree.node(node.first_child).size, Reverse(node.first_child), index));
        }
        if parent >= 0 && node.next_sibling != NONE {
            heap.push((tree.node(node.next_sibling).size, Reverse(node.next_sibling), parent));
        }
    }

    // 统计每个已选目录中「已导出子项」的大小，剩余部分合并为虚拟节点
    let mut child_bytes = vec![0u64; picked.len()];
    let mut child_files = vec![0u64; picked.len()];
    for &(id, parent) in &picked[1..] {
        let node = tree.node(id);
        child_bytes[parent as usize] += node.size;
        child_files[parent as usize] += node.file_count as u64;
    }

    let mut count = 0u32;
    for &(id, parent) in &picked {
        let node = tree.node(id);
        let mut flags = 0u8;
        if node.flags & FLAG_DIR != 0 {
            flags |= SNAP_FLAG_DIR;
        }
        if node.flags & FLAG_UNREADABLE != 0 {
            flags |= SNAP_FLAG_UNREADABLE;
        }
        write_node(&mut out, SnapNode { src: id, parent, size: node.size, files: node.file_count, modified: node.modified, flags }, tree.name(id));
        count += 1;
    }

    for (index, &(id, _)) in picked.iter().enumerate() {
        let node = tree.node(id);
        if node.flags & FLAG_DIR == 0 {
            continue;
        }
        let rest_bytes = node.size.saturating_sub(child_bytes[index]);
        let rest_files = (node.file_count as u64).saturating_sub(child_files[index]);
        if rest_files == 0 && rest_bytes == 0 {
            continue;
        }
        let name = format!("<其余 {rest_files} 个文件>");
        let synthetic = SnapNode {
            src: NONE,
            parent: index as i32,
            size: rest_bytes,
            files: rest_files.min(u32::MAX as u64) as u32,
            modified: 0,
            flags: SNAP_FLAG_SYNTHETIC,
        };
        write_node(&mut out, synthetic, &name);
        count += 1;
    }

    out[4..8].copy_from_slice(&count.to_le_bytes());
    out
}

struct SnapNode {
    src: u32,
    parent: i32,
    size: u64,
    files: u32,
    modified: u32,
    flags: u8,
}

fn write_node(out: &mut Vec<u8>, node: SnapNode, name: &str) {
    out.extend_from_slice(&node.src.to_le_bytes());
    out.extend_from_slice(&node.parent.to_le_bytes());
    out.extend_from_slice(&(node.size as f64).to_le_bytes());
    out.extend_from_slice(&node.files.to_le_bytes());
    out.extend_from_slice(&node.modified.to_le_bytes());
    out.push(node.flags);
    let mut len = name.len().min(u16::MAX as usize);
    while !name.is_char_boundary(len) {
        len -= 1;
    }
    out.extend_from_slice(&(len as u16).to_le_bytes());
    out.extend_from_slice(&name.as_bytes()[..len]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::FLAG_DIR;

    #[test]
    fn snapshot_prunes_small_items() {
        let mut t = FlatTree::default();
        t.set_root_path("/");
        let root = t.push(NONE, "/", 0, 0, FLAG_DIR);
        for i in 0..10u64 {
            t.push(root, &format!("f{i}"), (i + 1) * 100, 0, 0);
        }
        t.finalize();

        let bytes = export_snapshot(&t, 4);
        assert_eq!(&bytes[0..4], SNAPSHOT_MAGIC);
        // 根 + 3 个最大文件 + 1 个合并节点
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 5);
    }
}
