//! 扁平化目录树。
//!
//! 千万级文件时，嵌套结构（每个节点一个 struct + 一个 slice）的内存会超过 1GB，
//! 而且指针跳转对 CPU 缓存很不友好。这里改为：
//!
//!   - 所有节点放进一个连续切片，用 uint32 下标代替指针；
//!   - 子节点用 firstChild / nextSibling 串成单链表，并且**按大小降序链接**，
//!     UI 取「最大的 N 个子项」时不用再排序；
//!   - 所有名字拼接进同一个 []byte，节点只记录偏移和长度。
//!
//! 约定：节点必须**先插父、后插子**（父下标 < 子下标），这样 Finalize 倒序扫描一遍
//! 就能自底向上汇总目录大小，不需要递归。

package core

import (
	"sort"
	"strings"
	"sync"
	"unsafe"
)

// None 表示「没有节点」的下标。
const None uint32 = 0xFFFFFFFF

const (
	FlagDir uint16 = 1 << 0
	// FlagDeleted：已从树中移除（移到回收站之后）。
	FlagDeleted uint16 = 1 << 1
	// FlagUnreadable：目录无法读取（权限不足、已被删除等），大小可能偏小。
	FlagUnreadable uint16 = 1 << 2
)

// FlatNode 是单个节点。字段顺序与磁盘布局无关（不像 Rust 版要维持 40 字节
// repr(C)），但语义一一对应。
type FlatNode struct {
	// Size：文件为逻辑大小；目录为子树总大小（Finalize 之后有效）。
	Size        uint64
	Parent      uint32
	FirstChild  uint32
	NextSibling uint32
	NameOffset  uint32
	// FileCount：文件为 1；目录为子树内的文件总数。
	FileCount uint32
	// Modified：修改时间（Unix 秒，uint32 可用到 2106 年）。
	Modified uint32
	NameLen  uint16
	Flags    uint16
}

// ExtStat 是按扩展名汇总的一条记录。
type ExtStat struct {
	Ext   string `json:"ext"`
	Size  uint64 `json:"size"`
	Count uint64 `json:"count"`
}

// FlatTree 是扁平目录树。
type FlatTree struct {
	nodes    []FlatNode
	names    []byte
	rootPath string
}

// NewFlatTree 建一棵预分配的树。
func NewFlatTree(nodes, nameBytes int) *FlatTree {
	return &FlatTree{
		nodes: make([]FlatNode, 0, max(nodes, 0)),
		names: make([]byte, 0, max(nameBytes, 0)),
	}
}

// SetRootPath 记录根路径（Path 拼装要用）。
func (t *FlatTree) SetRootPath(p string) { t.rootPath = p }

// RootPath 返回根路径。
func (t *FlatTree) RootPath() string { return t.rootPath }

// Push 追加一个节点，返回它的下标。parent 必须已经存在（或为 None 表示根）。
func (t *FlatTree) Push(parent uint32, name string, size uint64, modified uint32, flags uint16) uint32 {
	id := uint32(len(t.nodes))
	if parent != None && parent >= id {
		// 上游 Rust 版这里是 debug_assert，release 下不检查。Go 没有 debug/release
		// 之分，改成静默纠正：把越界的 parent 当根，否则 finalize 阶段会越界 panic。
		parent = None
	}

	// 名字超过 uint16 时截断，并保证落在 UTF-8 字符边界上
	b := []byte(name)
	if len(b) > 0xFFFF {
		b = b[:0xFFFF]
		for len(b) > 0 && !utf8Boundary(b, len(b)) {
			b = b[:len(b)-1]
		}
	}
	nameOffset := uint32(len(t.names))
	t.names = append(t.names, b...)

	isDir := flags&FlagDir != 0
	node := FlatNode{
		Size:       size,
		Parent:     parent,
		FirstChild: None,
		// 子节点按大小降序链接，head 是最大的那个
		NextSibling: None,
		NameOffset:  nameOffset,
		FileCount:   1,
		Modified:    modified,
		NameLen:     uint16(len(b)),
		Flags:       flags,
	}
	if isDir {
		// 目录的 size / fileCount 在 Finalize 里自底向上汇总
		node.Size = 0
		node.FileCount = 0
	}
	t.nodes = append(t.nodes, node)
	return id
}

// utf8Boundary 报告字节长度 n 是否落在合法 UTF-8 字符边界上。
func utf8Boundary(b []byte, n int) bool {
	if n <= 0 || n >= len(b) {
		return true
	}
	return b[n]&0xC0 != 0x80
}

// Finalize 自底向上汇总目录大小，并把子节点按大小降序串成链表。
//
// 复杂度 O(n) + 每个目录内部排序，全程不递归。可以重复调用。
func (t *FlatTree) Finalize() {
	n := len(t.nodes)
	if n == 0 {
		return
	}

	// 1. 重置目录汇总值
	for i := range t.nodes {
		if t.nodes[i].Flags&FlagDir != 0 {
			t.nodes[i].Size = 0
			t.nodes[i].FileCount = 0
		}
		t.nodes[i].FirstChild = None
		t.nodes[i].NextSibling = None
	}

	// 2. 倒序累加：处理到 id 时，它的所有后代（下标都更大）已经加进它里面了
	for id := n - 1; id >= 1; id-- {
		node := t.nodes[id]
		if node.Flags&FlagDeleted != 0 || node.Parent == None {
			continue
		}
		p := t.nodes[node.Parent]
		p.Size += node.Size
		p.FileCount += node.FileCount
		t.nodes[node.Parent] = p
	}

	// 3. 按父节点做一次计数排序（CSR），得到每个目录的子节点区间
	start := make([]uint32, n+1)
	for id := 1; id < n; id++ {
		node := t.nodes[id]
		if node.Parent != None && node.Flags&FlagDeleted == 0 {
			start[node.Parent+1]++
		}
	}
	for i := 0; i < n; i++ {
		start[i+1] += start[i]
	}
	fill := make([]uint32, n+1)
	copy(fill, start)
	order := make([]uint32, start[n])
	for id := 1; id < n; id++ {
		node := t.nodes[id]
		if node.Parent != None && node.Flags&FlagDeleted == 0 {
			p := node.Parent
			order[fill[p]] = uint32(id)
			fill[p]++
		}
	}

	// 4. 每组按大小降序排列
	for p := 0; p < n; p++ {
		group := order[start[p]:start[p+1]]
		if len(group) > 1 {
			sort.Slice(group, func(a, b int) bool {
				return t.nodes[group[a]].Size > t.nodes[group[b]].Size
			})
		}
	}

	// 5. 串成链表
	for p := 0; p < n; p++ {
		group := order[start[p]:start[p+1]]
		if len(group) == 0 {
			continue
		}
		t.nodes[p].FirstChild = group[0]
		for k := 0; k+1 < len(group); k++ {
			t.nodes[group[k]].NextSibling = group[k+1]
		}
	}
}

// Len 返回节点数。
func (t *FlatTree) Len() int { return len(t.nodes) }

// IsEmpty 报树是否为空。
func (t *FlatTree) IsEmpty() bool { return len(t.nodes) == 0 }

// Contains 报下标是否有效。
func (t *FlatTree) Contains(id uint32) bool { return int(id) < len(t.nodes) }

// Node 返回节点（调用方要自己保证 id 有效）。
func (t *FlatTree) Node(id uint32) *FlatNode { return &t.nodes[id] }

// Name 返回节点名字。
func (t *FlatTree) Name(id uint32) string {
	n := t.nodes[id]
	start := n.NameOffset
	end := int(start) + int(n.NameLen)
	if end > len(t.names) {
		return ""
	}
	// 名字都是从合法字符串写入且按字符边界截断的，这里总是合法 UTF-8
	return string(t.names[start:end])
}

// IsDir 报节点是否为目录。
func (t *FlatTree) IsDir(id uint32) bool { return t.nodes[id].Flags&FlagDir != 0 }

// IsDeleted 报节点是否已被移除。
func (t *FlatTree) IsDeleted(id uint32) bool { return t.nodes[id].Flags&FlagDeleted != 0 }

// DirCount 统计目录数。
func (t *FlatTree) DirCount() uint64 {
	var c uint64
	for i := range t.nodes {
		if t.nodes[i].Flags&FlagDir != 0 && t.nodes[i].Flags&FlagDeleted == 0 {
			c++
		}
	}
	return c
}

// Children 返回按大小降序排列的直接子节点（已跳过被移除的）。
func (t *FlatTree) Children(id uint32) []uint32 {
	var out []uint32
	for next := t.nodes[id].FirstChild; next != None; {
		cur := next
		next = t.nodes[cur].NextSibling
		if t.IsDeleted(cur) {
			continue
		}
		out = append(out, cur)
	}
	return out
}

// Path 返回节点的完整路径。
func (t *FlatTree) Path(id uint32) string {
	var chain []uint32
	cur := id
	for cur != None && int(cur) < len(t.nodes) {
		chain = append(chain, cur)
		cur = t.nodes[cur].Parent
	}
	var b strings.Builder
	b.WriteString(t.rootPath)
	// chain 是从 id 一路向上收集的，倒序后第 0 个是根节点自己 —— 它的名字
	// 就是 rootPath，跳过，否则会拼成 `C:\C:\a`。
	for i := len(chain) - 2; i >= 0; i-- {
		s := b.String()
		if s != "" && !strings.HasSuffix(s, `\`) && !strings.HasSuffix(s, "/") {
			b.WriteByte('\\')
		}
		b.WriteString(t.Name(chain[i]))
	}
	return b.String()
}

// MemoryBytes 返回结构体本身占用的堆内存（近似值）。
func (t *FlatTree) MemoryBytes() int { return cap(t.nodes)*nodeSize + cap(t.names) }

// nodeSize 是 FlatNode 的内存尺寸，只用于 MemoryBytes 的估算。
const nodeSize = int(unsafe.Sizeof(FlatNode{}))

// RemoveSubtree 删除一个子树（例如移到回收站之后），同步更新所有祖先的大小。
// 返回 (释放字节数, 释放文件数)；根节点、越界或已删除的节点返回 ok=false。
func (t *FlatTree) RemoveSubtree(id uint32) (freedBytes uint64, freedFiles uint32, ok bool) {
	if id == 0 || !t.Contains(id) || t.IsDeleted(id) {
		return 0, 0, false
	}
	node := t.nodes[id]
	size, fileCount, parent, nextSibling := node.Size, node.FileCount, node.Parent, node.NextSibling

	// 标记整个子树
	stack := []uint32{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		t.nodes[cur].Flags |= FlagDeleted
		for child := t.nodes[cur].FirstChild; child != None; child = t.nodes[child].NextSibling {
			stack = append(stack, child)
		}
	}

	// 从父节点的兄弟链表中摘除
	if parent != None {
		if t.nodes[parent].FirstChild == id {
			t.nodes[parent].FirstChild = nextSibling
		} else {
			cur := t.nodes[parent].FirstChild
			for cur != None {
				next := t.nodes[cur].NextSibling
				if next == id {
					t.nodes[cur].NextSibling = nextSibling
					break
				}
				cur = next
			}
		}
	}

	// 祖先减去对应大小
	for cur := parent; cur != None; cur = t.nodes[cur].Parent {
		n := &t.nodes[cur]
		n.Size = saturatingSub(n.Size, size)
		n.FileCount = saturatingSubU32(n.FileCount, fileCount)
	}
	return size, fileCount, true
}

func saturatingSub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

func saturatingSubU32(a, b uint32) uint32 {
	if a < b {
		return 0
	}
	return a - b
}

// TopFiles 返回全盘最大的 limit 个文件（用容量 limit+1 的小顶堆，O(n log k)）。
func (t *FlatTree) TopFiles(limit int) []uint32 {
	if limit <= 0 {
		return nil
	}
	// (size, id) 组成的小顶堆：size 相同时 id 大的先出，保证结果确定
	h := make(nodeHeap, 0, limit+1)
	push := func(size uint64, id uint32) {
		h = append(h, nodeRef{size: size, id: id})
		up(h, len(h)-1)
	}
	pop := func() nodeRef {
		top := h[0]
		h[0] = h[len(h)-1]
		h = h[:len(h)-1]
		if len(h) > 0 {
			down(h, 0)
		}
		return top
	}

	for i := range t.nodes {
		node := &t.nodes[i]
		if node.Flags&(FlagDir|FlagDeleted) != 0 {
			continue
		}
		if len(h) < limit {
			push(node.Size, uint32(i))
			continue
		}
		if node.Size > h[0].size {
			pop()
			push(node.Size, uint32(i))
		}
	}
	result := make([]uint32, 0, len(h))
	for _, ref := range h {
		result = append(result, ref.id)
	}
	// 结果按大小降序；size 相同按 id 升序，保证可复现
	sort.Slice(result, func(a, b int) bool {
		na, nb := t.nodes[result[a]], t.nodes[result[b]]
		if na.Size != nb.Size {
			return na.Size > nb.Size
		}
		return result[a] < result[b]
	})
	return result
}

type nodeRef struct {
	size uint64
	id   uint32
}

type nodeHeap []nodeRef

func up(h nodeHeap, i int) {
	for i > 0 {
		parent := (i - 1) / 2
		if h[i].size > h[parent].size || (h[i].size == h[parent].size && h[i].id <= h[parent].id) {
			break
		}
		h[i], h[parent] = h[parent], h[i]
		i = parent
	}
}

func down(h nodeHeap, i int) {
	n := len(h)
	for {
		l, r := 2*i+1, 2*i+2
		small := i
		if l < n && (h[l].size < h[small].size || (h[l].size == h[small].size && h[l].id < h[small].id)) {
			small = l
		}
		if r < n && (h[r].size < h[small].size || (h[r].size == h[small].size && h[r].id < h[small].id)) {
			small = r
		}
		if small == i {
			return
		}
		h[i], h[small] = h[small], h[i]
		i = small
	}
}

// ExtStats 按扩展名汇总。
func (t *FlatTree) ExtStats() []ExtStat {
	type acc struct {
		size  uint64
		count uint64
	}
	// 先按分片并行统计各自的 map，再合并 —— 节点数可能上千万，
	// 全程一把大锁会拖慢扫描后的查询。
	shards := 8
	maps := make([]map[string]acc, shards)
	for i := range maps {
		maps[i] = make(map[string]acc, 64)
	}
	var wg sync.WaitGroup
	chunk := divCeil(len(t.nodes), shards)
	for s := 0; s < shards; s++ {
		start := s * chunk
		end := start + chunk
		if end > len(t.nodes) {
			end = len(t.nodes)
		}
		if start >= end {
			continue
		}
		wg.Add(1)
		go func(m map[string]acc, from, to int) {
			defer wg.Done()
			for i := from; i < to; i++ {
				if t.nodes[i].Flags&(FlagDir|FlagDeleted) != 0 {
					continue
				}
				key := ExtOf(t.Name(uint32(i)))
				e := m[key]
				e.size += t.nodes[i].Size
				e.count++
				m[key] = e
			}
		}(maps[s], start, end)
	}
	wg.Wait()

	total := make(map[string]acc, len(maps[0]))
	for _, m := range maps {
		for k, v := range m {
			e := total[k]
			e.size += v.size
			e.count += v.count
			total[k] = e
		}
	}
	stats := make([]ExtStat, 0, len(total))
	for k, v := range total {
		stats = append(stats, ExtStat{Ext: k, Size: v.size, Count: v.count})
	}
	sort.Slice(stats, func(a, b int) bool { return stats[a].Size > stats[b].Size })
	return stats
}

// Search 是文件名子串搜索（ASCII 不区分大小写），结果按大小降序。
func (t *FlatTree) Search(needle string, limit int) []uint32 {
	n := strings.ToLower(strings.TrimLeft(strings.TrimSpace(needle), "*"))
	if n == "" {
		return nil
	}
	var hits []uint32
	for id := 1; id < len(t.nodes); id++ {
		if t.nodes[id].Flags&FlagDeleted != 0 {
			continue
		}
		if containsIgnoreASCIICase(t.Name(uint32(id)), n) {
			hits = append(hits, uint32(id))
		}
	}
	sort.Slice(hits, func(a, b int) bool {
		return t.nodes[hits[a]].Size > t.nodes[hits[b]].Size
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

// ExtOf 返回小写扩展名（不含点）。`.gitignore` 这类隐藏文件视为没有扩展名。
func ExtOf(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 || i+1 >= len(name) {
		return ""
	}
	return strings.ToLower(name[i+1:])
}

func containsIgnoreASCIICase(haystack, needleLower string) bool {
	h := []byte(haystack)
	n := []byte(needleLower)
	if len(n) == 0 || len(n) > len(h) {
		return false
	}
	for i := 0; i+len(n) <= len(h); i++ {
		ok := true
		for j := 0; j < len(n); j++ {
			c := h[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != n[j] {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func divCeil(a, b int) int {
	if b <= 0 {
		return 0
	}
	return (a + b - 1) / b
}
