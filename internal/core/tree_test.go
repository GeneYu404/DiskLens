package core

import (
	"fmt"
	"strings"
	"testing"
)

func sample() *FlatTree {
	tree := &FlatTree{}
	tree.SetRootPath(`C:\`)
	root := tree.Push(None, `C:\`, 0, 0, FlagDir)
	a := tree.Push(root, "a", 0, 0, FlagDir)
	tree.Push(root, "big.iso", 500, 0, 0)
	tree.Push(a, "x.txt", 100, 0, 0)
	tree.Push(a, "y.TXT", 300, 0, 0)
	tree.Finalize()
	return tree
}

func childNames(tree *FlatTree, id uint32) []string {
	var out []string
	for _, c := range tree.Children(id) {
		out = append(out, tree.Name(c))
	}
	return out
}

func namesOf(tree *FlatTree, ids []uint32) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, tree.Name(id))
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestAggregatesAndSortsChildren(t *testing.T) {
	tree := sample()
	if got := tree.Node(0).Size; got != 900 {
		t.Errorf("根目录大小 = %d, 期望 900", got)
	}
	if got := tree.Node(0).FileCount; got != 3 {
		t.Errorf("根目录文件数 = %d, 期望 3", got)
	}
	if got := tree.Node(1).Size; got != 400 {
		t.Errorf("子目录 a 大小 = %d, 期望 400", got)
	}
	if names := childNames(tree, 0); !equalStrings(names, []string{"big.iso", "a"}) {
		t.Errorf("根目录子项 = %v, 期望 [big.iso a]", names)
	}
	if names := childNames(tree, 1); !equalStrings(names, []string{"y.TXT", "x.txt"}) {
		t.Errorf("a 的子项 = %v, 期望 [y.TXT x.txt]", names)
	}
}

func TestRemoveSubtreeUpdatesAncestors(t *testing.T) {
	tree := sample()
	bytes, files, ok := tree.RemoveSubtree(1)
	if !ok || bytes != 400 || files != 2 {
		t.Fatalf("RemoveSubtree(1) = (%d, %d, %t), 期望 (400, 2, true)", bytes, files, ok)
	}
	if got := tree.Node(0).Size; got != 500 {
		t.Errorf("删除后根大小 = %d, 期望 500", got)
	}
	if got := tree.Node(0).FileCount; got != 1 {
		t.Errorf("删除后根文件数 = %d, 期望 1", got)
	}
	if n := len(tree.Children(0)); n != 1 {
		t.Errorf("删除后根子项数 = %d, 期望 1", n)
	}
	if _, _, ok := tree.RemoveSubtree(1); ok {
		t.Error("重复删除同一子树应当失败")
	}
}

func TestQueries(t *testing.T) {
	tree := sample()

	if top := namesOf(tree, tree.TopFiles(2)); !equalStrings(top, []string{"big.iso", "y.TXT"}) {
		t.Errorf("TopFiles = %v, 期望 [big.iso y.TXT]", top)
	}

	ext := tree.ExtStats()
	if len(ext) != 2 {
		t.Fatalf("ExtStats 返回 %d 条, 期望 2", len(ext))
	}
	if ext[0].Ext != "iso" {
		t.Errorf("第一大扩展名 = %q, 期望 iso", ext[0].Ext)
	}
	if ext[1].Ext != "txt" || ext[1].Count != 2 {
		t.Errorf("第二条 = %q×%d, 期望 txt×2", ext[1].Ext, ext[1].Count)
	}

	if n := len(tree.Search("*.txt", 10)); n != 2 {
		t.Errorf("Search(*.txt) = %d 条, 期望 2", n)
	}
	if p := tree.Path(3); !strings.HasSuffix(p, "x.txt") {
		t.Errorf("Path(3) = %q, 期望以 x.txt 结尾", p)
	}
}

func TestExtOf(t *testing.T) {
	cases := map[string]string{
		"a.txt":      "txt",
		"A.TXT":      "txt",
		".gitignore": "", // 隐藏文件视为没有扩展名
		"noext":      "",
		"a.tar.gz":   "gz",
		"trailing.":  "",
	}
	for in, want := range cases {
		if got := ExtOf(in); got != want {
			t.Errorf("ExtOf(%q) = %q, 期望 %q", in, got, want)
		}
	}
}

func TestPushTruncatesLongNamesOnCharBoundary(t *testing.T) {
	tree := &FlatTree{}
	// 造一个长度超过 65535 字节的多字节名字
	long := strings.Repeat("中", 30000)
	id := tree.Push(None, long, 1, 0, 0)
	name := tree.Name(id)
	if name == "" {
		t.Fatal("截断后名字不应为空")
	}
	// 必须是合法的 UTF-8（没有把字符切成半个）
	if strings.ContainsRune(name, '\uFFFD') {
		t.Fatal("名字被截断在字符边界中间")
	}
}

func TestPushSelfCorrectsBadParent(t *testing.T) {
	// 上游 Rust 版这里只有 debug_assert，release 下 parent 越界会在 finalize
	// 阶段 panic。Go 没有 debug/release 之分，这里确认会自纠正成根。
	tree := &FlatTree{}
	tree.Push(999, "orphan", 1, 0, 0)
	tree.Finalize() // 不应 panic
	if got := tree.Node(0).Size; got != 1 {
		t.Errorf("越界 parent 应被当成根，根大小 = %d, 期望 1", got)
	}
}

func TestSummaryCountsRoot(t *testing.T) {
	tree := sample()
	s := Summary(tree)
	if s.Files != 3 {
		t.Errorf("汇总文件数 = %d, 期望 3", s.Files)
	}
	if s.Bytes != 900 {
		t.Errorf("汇总大小 = %d, 期望 900", s.Bytes)
	}
	if s.Dirs != 2 {
		t.Errorf("汇总目录数 = %d, 期望 2", s.Dirs)
	}
	if s.Root != `C:\` {
		t.Errorf("汇总根路径 = %q", s.Root)
	}
	if s.Nodes != 5 {
		t.Errorf("汇总节点数 = %d, 期望 5", s.Nodes)
	}
	_ = fmt.Sprint(s)
}
