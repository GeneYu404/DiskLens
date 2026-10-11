package core

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotPrunesSmallItems(t *testing.T) {
	tr := &FlatTree{}
	tr.SetRootPath("/")
	root := tr.Push(None, "/", 0, 0, FlagDir)
	for i := 0; i < 10; i++ {
		tr.Push(root, fmt.Sprintf("f%d", i), uint64((i+1)*100), 0, 0)
	}
	tr.Finalize()

	b := ExportSnapshot(tr, 4)
	if string(b[0:4]) != "DLS1" {
		t.Fatalf("魔数 = %q, 期望 DLS1", b[0:4])
	}
	// 根 + 3 个最大文件 + 1 个合并节点
	if n := binary.LittleEndian.Uint32(b[4:8]); n != 5 {
		t.Errorf("快照节点数 = %d, 期望 5", n)
	}
}

func TestSnapshotFormatRoundTrip(t *testing.T) {
	tr := &FlatTree{}
	tr.SetRootPath(`C:\`)
	root := tr.Push(None, `C:\`, 0, 1000, FlagDir)
	tr.Push(root, "中文名.bin", 4096, 1700000000, 0)
	tr.Finalize()

	b := ExportSnapshot(tr, 100)
	off := 8
	src := binary.LittleEndian.Uint32(b[off:])
	parent := int32(binary.LittleEndian.Uint32(b[off+4:]))
	// size 在快照里是 f64（走 JSON 数字那条路），不是 u64
	size := math.Float64frombits(binary.LittleEndian.Uint64(b[off+8:]))
	flags := b[off+24]
	nameLen := int(binary.LittleEndian.Uint16(b[off+25:]))
	if got := string(b[off+27 : off+27+nameLen]); got != `C:\` {
		t.Errorf("根节点名 = %q, 期望 C:\\", got)
	}

	if src != 0 {
		t.Errorf("根节点 src_id = %d, 期望 0", src)
	}
	if parent != -1 {
		t.Errorf("根节点 parent = %d, 期望 -1", parent)
	}
	// 根是目录，size = 子树总大小 = 4096
	if size != 4096 {
		t.Errorf("根节点 size = %v, 期望 4096", size)
	}
	if flags&SnapFlagDir == 0 {
		t.Error("根节点应当带 SnapFlagDir")
	}

	// 第二个节点就是那个中文名文件
	off = 8 + 27 + nameLen
	childNameLen := int(binary.LittleEndian.Uint16(b[off+25:]))
	childName := string(b[off+27 : off+27+childNameLen])
	if childName != "中文名.bin" {
		t.Errorf("子节点名 = %q, 期望 中文名.bin", childName)
	}
}

func TestWalkTempDirectory(t *testing.T) {
	root := filepath.Join(os.TempDir(), fmt.Sprintf("disklens-test-%d", os.Getpid()))
	_ = os.RemoveAll(root)
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	if err := os.MkdirAll(filepath.Join(root, "sub", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(rel string, n int) {
		if err := os.WriteFile(filepath.Join(root, rel), make([]byte, n), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.bin", 1000)
	write(filepath.Join("sub", "b.txt"), 300)
	write(filepath.Join("sub", "deeper", "c.txt"), 200)

	progress := &ScanProgress{}
	opts := DefaultScanOptions()
	opts.Engine = EngineWalk
	opts.Threads = 2

	tree, err := Walk(root, opts, progress)
	if err != nil {
		t.Fatalf("Walk 失败: %v", err)
	}
	if got := tree.Node(0).Size; got != 1500 {
		t.Errorf("总大小 = %d, 期望 1500", got)
	}
	if got := tree.Node(0).FileCount; got != 3 {
		t.Errorf("文件数 = %d, 期望 3", got)
	}
	children := tree.Children(0)
	if len(children) == 0 {
		t.Fatal("根目录没有子项")
	}
	if name := tree.Name(children[0]); name != "a.bin" {
		t.Errorf("第一个子项 = %q, 期望 a.bin（应按大小降序）", name)
	}
}

// TestWalkSingleThreadNoDeadlock 回归测试：信号量槽位如果覆盖「等子目录」那一段，
// 并发度为 1 时父子互相等，直接死锁。这里用带超时的方式跑，挂了就会失败而不是
// 让整个测试套件卡住。
func TestWalkSingleThreadNoDeadlock(t *testing.T) {
	root := filepath.Join(os.TempDir(), fmt.Sprintf("disklens-dead-%d", os.Getpid()))
	_ = os.RemoveAll(root)
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	// 造一条 30 层深的链，逼出「父持槽等子」的死锁
	cur := root
	for i := 0; i < 30; i++ {
		cur = filepath.Join(cur, "d")
	}
	if err := os.MkdirAll(cur, 0o755); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		opts := DefaultScanOptions()
		opts.Engine = EngineWalk
		opts.Threads = 1
		_, err := Walk(root, opts, &ScanProgress{})
		done <- err
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Walk 失败: %v", err)
		}
	case <-timeoutAfter(10):
		t.Fatal("Walk 在单线程下死锁（父 goroutine 持槽等子）")
	}
}

func TestScanRespectsCancel(t *testing.T) {
	root := filepath.Join(os.TempDir(), fmt.Sprintf("disklens-cancel-%d", os.Getpid()))
	_ = os.RemoveAll(root)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.MkdirAll(filepath.Join(root, "a"), 0o755); err != nil {
		t.Fatal(err)
	}

	progress := &ScanProgress{}
	progress.Cancel()
	tree, err := Walk(root, DefaultScanOptions(), progress)
	if err != nil {
		t.Fatalf("取消后 Walk 不该报错: %v", err)
	}
	if tree.Node(0).FileCount != 0 {
		t.Error("已取消的扫描不应统计到文件")
	}
}
