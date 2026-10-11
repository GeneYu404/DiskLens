//! 面向 UI 的查询：只返回界面需要显示的那一小部分数据。
//!
//!   - ChildrenPage：懒加载目录树，一次只取一层、一页；
//!   - TopFiles / Search：Top-N 结果，带完整路径；
//!   - ExportSnapshot：把「最大的 N 个节点」导出为紧凑二进制，
//!     较小的项合并成 `<其余 N 个文件>`（与矩形树图合并小块的思路一致），
//!     前端可以一次性拿到足够绘制树图和列表的数据，而传输量有上限。

package core

import (
	"container/heap"
	"encoding/binary"
	"math"
	"strconv"
	"unicode/utf16"
)

// 快照格式常量。前端 src/lib/backend.ts 的 decodeSnapshot 按同样的格式解码，
// **两边必须同步改**。
var SnapshotMagic = [4]byte{'D', 'L', 'S', '1'}

const (
	SnapFlagDir        uint8 = 1 << 0
	SnapFlagUnreadable uint8 = 1 << 1
	SnapFlagSynthetic  uint8 = 1 << 2
)

// NodeInfo 是给前端展示的节点信息。
type NodeInfo struct {
	ID          uint32 `json:"id"`
	Name        string `json:"name"`
	Size        uint64 `json:"size"`
	FileCount   uint32 `json:"fileCount"`
	Modified    uint32 `json:"modified"`
	IsDir       bool   `json:"isDir"`
	HasChildren bool   `json:"hasChildren"`
	Unreadable  bool   `json:"unreadable"`
}

// FileHit 是 Top-N / 搜索结果。
type FileHit struct {
	ID       uint32 `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	Size     uint64 `json:"size"`
	Modified uint32 `json:"modified"`
	IsDir    bool   `json:"isDir"`
}

// TreeSummary 是整棵树的汇总。
type TreeSummary struct {
	Root        string `json:"root"`
	Nodes       int    `json:"nodes"`
	Files       uint64 `json:"files"`
	Dirs        uint64 `json:"dirs"`
	Bytes       uint64 `json:"bytes"`
	MemoryBytes int    `json:"memoryBytes"`
}

// NodeInfoOf 取一个节点的信息。
func NodeInfoOf(tree *FlatTree, id uint32) (NodeInfo, bool) {
	if !tree.Contains(id) {
		return NodeInfo{}, false
	}
	n := tree.Node(id)
	return NodeInfo{
		ID:          id,
		Name:        tree.Name(id),
		Size:        n.Size,
		FileCount:   n.FileCount,
		Modified:    n.Modified,
		IsDir:       n.Flags&FlagDir != 0,
		HasChildren: n.FirstChild != None,
		Unreadable:  n.Flags&FlagUnreadable != 0,
	}, true
}

// ChildrenPage 返回某个目录的子项（已按大小降序），分页。
func ChildrenPage(tree *FlatTree, id uint32, offset, limit int) []NodeInfo {
	if !tree.Contains(id) {
		return nil
	}
	children := tree.Children(id)
	if offset > len(children) {
		return nil
	}
	children = children[offset:]
	if limit > 0 && limit < len(children) {
		children = children[:limit]
	}
	out := make([]NodeInfo, 0, len(children))
	for _, c := range children {
		if info, ok := NodeInfoOf(tree, c); ok {
			out = append(out, info)
		}
	}
	return out
}

func hitOf(tree *FlatTree, id uint32) FileHit {
	n := tree.Node(id)
	return FileHit{
		ID:       id,
		Name:     tree.Name(id),
		Path:     tree.Path(id),
		Size:     n.Size,
		Modified: n.Modified,
		IsDir:    n.Flags&FlagDir != 0,
	}
}

// TopFilesOf 返回全盘最大的 limit 个文件。
func TopFilesOf(tree *FlatTree, limit int) []FileHit {
	ids := tree.TopFiles(limit)
	out := make([]FileHit, 0, len(ids))
	for _, id := range ids {
		out = append(out, hitOf(tree, id))
	}
	return out
}

// SearchOf 按名字子串搜索。
func SearchOf(tree *FlatTree, query string, limit int) []FileHit {
	ids := tree.Search(query, limit)
	out := make([]FileHit, 0, len(ids))
	for _, id := range ids {
		out = append(out, hitOf(tree, id))
	}
	return out
}

// Summary 返回整棵树的汇总。
func Summary(tree *FlatTree) TreeSummary {
	var files, bytes uint64
	if !tree.IsEmpty() {
		root := tree.Node(0)
		files = uint64(root.FileCount)
		bytes = root.Size
	}
	return TreeSummary{
		Root:        tree.RootPath(),
		Nodes:       tree.Len(),
		Files:       files,
		Dirs:        tree.DirCount(),
		Bytes:       bytes,
		MemoryBytes: tree.MemoryBytes(),
	}
}

// snapItem 是「最大优先」扩展时的堆元素。
type snapItem struct {
	size   uint64
	id     uint32
	parent int32
	index  uint32
}

type snapHeap []snapItem

func (h snapHeap) Len() int { return len(h) }
func (h snapHeap) Less(i, j int) bool {
	if h[i].size != h[j].size {
		return h[i].size > h[j].size
	}
	// 同大小时先取 id 小的，导出结果因此是确定的
	return h[i].id < h[j].id
}
func (h snapHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *snapHeap) Push(x any)   { *h = append(*h, x.(snapItem)) }
func (h *snapHeap) Pop() any     { old := *h; n := len(old); it := old[n-1]; *h = old[:n-1]; return it }

// ExportSnapshot 导出剪枝快照。
//
// 从根开始做「最大优先」扩展：堆里只放每个已选节点的第一个子节点和下一个兄弟
// （子链表本身已按大小降序），因此堆大小始终是 O(已选节点数)。
// 父节点一定先于子节点被选中，导出顺序天然满足「父下标 < 子下标」。
//
// 格式（小端）：
//
//	magic "DLS1" | count: u32 |
//	每个节点: src_id u32 | parent i32 | size f64 | file_count u32 | modified u32 |
//	          flags u8 | name_len u16 | name UTF-8
//
// src_id == 0xFFFFFFFF 表示合并出来的虚拟节点。
func ExportSnapshot(tree *FlatTree, maxNodes int) []byte {
	out := make([]byte, 0, 64+min(maxNodes, tree.Len())*48)
	out = append(out, SnapshotMagic[:]...)
	out = append(out, 0, 0, 0, 0) // count 占位，最后回填
	if tree.IsEmpty() {
		return out
	}
	if maxNodes < 1 {
		maxNodes = 1
	}

	type pickedItem struct {
		id     uint32
		parent int32
	}
	picked := make([]pickedItem, 0, min(maxNodes, tree.Len()))
	h := &snapHeap{{size: tree.Node(0).Size, id: 0, parent: -1}}

	for h.Len() > 0 && len(picked) < maxNodes {
		item := heap.Pop(h).(snapItem)
		index := int32(len(picked))
		picked = append(picked, pickedItem{id: item.id, parent: item.parent})

		node := tree.Node(item.id)
		if node.FirstChild != None {
			heap.Push(h, snapItem{size: tree.Node(node.FirstChild).Size, id: node.FirstChild, parent: index})
		}
		if item.parent >= 0 && node.NextSibling != None {
			heap.Push(h, snapItem{size: tree.Node(node.NextSibling).Size, id: node.NextSibling, parent: item.parent})
		}
	}

	// 统计每个已选目录中「已导出子项」的大小，剩余部分合并为虚拟节点
	childBytes := make([]uint64, len(picked))
	childFiles := make([]uint64, len(picked))
	for _, it := range picked[1:] {
		node := tree.Node(it.id)
		childBytes[it.parent] += node.Size
		childFiles[it.parent] += uint64(node.FileCount)
	}

	var count uint32
	for _, it := range picked {
		node := tree.Node(it.id)
		var flags uint8
		if node.Flags&FlagDir != 0 {
			flags |= SnapFlagDir
		}
		if node.Flags&FlagUnreadable != 0 {
			flags |= SnapFlagUnreadable
		}
		out = writeSnapNode(out, it.id, it.parent, node.Size, node.FileCount, node.Modified, flags, tree.Name(it.id))
		count++
	}

	for index, it := range picked {
		node := tree.Node(it.id)
		if node.Flags&FlagDir == 0 {
			continue
		}
		restBytes := saturatingSub(node.Size, childBytes[index])
		restFiles := saturatingSub(uint64(node.FileCount), childFiles[index])
		if restFiles == 0 && restBytes == 0 {
			continue
		}
		name := "<其余 " + strconv.FormatUint(restFiles, 10) + " 个文件>"
		out = writeSnapNode(out, None, int32(index), restBytes, uint32(min(restFiles, math.MaxUint32)), 0, SnapFlagSynthetic, name)
		count++
	}

	binary.LittleEndian.PutUint32(out[4:8], count)
	return out
}

func writeSnapNode(out []byte, src uint32, parent int32, size uint64, files, modified uint32, flags uint8, name string) []byte {
	var rec [27]byte
	binary.LittleEndian.PutUint32(rec[0:4], src)
	binary.LittleEndian.PutUint32(rec[4:8], uint32(parent))
	binary.LittleEndian.PutUint64(rec[8:16], math.Float64bits(float64(size)))
	binary.LittleEndian.PutUint32(rec[16:20], files)
	binary.LittleEndian.PutUint32(rec[20:24], modified)
	rec[24] = flags

	// 名字按 UTF-8 字节数截断，且要落在字符边界上（与 tree.Push 同一套规则）
	b := []byte(name)
	if len(b) > 0xFFFF {
		b = b[:0xFFFF]
		for len(b) > 0 && !utf8Boundary(b, len(b)) {
			b = b[:len(b)-1]
		}
	}
	binary.LittleEndian.PutUint16(rec[25:27], uint16(len(b)))
	out = append(out, rec[:]...)
	return append(out, b...)
}

// utf16UnitsToString 用于 MFT 解析（NTFS 文件名是 UTF-16LE）。
func utf16UnitsToString(units []uint16) string {
	return string(utf16.Decode(units))
}
