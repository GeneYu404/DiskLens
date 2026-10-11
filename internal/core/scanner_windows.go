//go:build windows

//! 通用扫描器：并行遍历目录（所有平台、所有文件系统可用）。
//!
//! 分两个阶段：
//!
//!  1. **并行阶段**：每个目录是一个任务，负责读取它的直接子项；子目录再派 goroutine。
//!     Go 的调度器自带工作窃取，不需要像 rayon 那样显式建线程池 —— 这里只用
//!     一个信号量把并发度限制在 opts.Threads（0 = 全部核心）。
//!  2. **扁平化阶段**：用显式栈把临时结构转换为 FlatTree，O(n)，不递归，
//!     转换过程中临时结构被逐步释放。
//!
//! 性能要点：
//!   - Windows 上 os.ReadDir 直接用 FindNextFileW 返回的数据，不额外 stat；
//!   - 进度计数器按目录批量累加，而不是每个文件一次原子操作；
//!   - 跳过符号链接和目录重解析点（junction），避免循环和重复统计。

package core

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"golang.org/x/sys/windows"
)

const fileAttributeReparsePoint uint32 = 0x400

type rawFile struct {
	name     string
	size     uint64
	modified uint32
}

type rawDir struct {
	name       string
	modified   uint32
	unreadable bool
	files      []rawFile
	dirs       []rawDir
}

// Walk 并行扫描 root，返回已 Finalize 的扁平树。
func Walk(root string, opts ScanOptions, progress *ScanProgress) (*FlatTree, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, &os.PathError{Op: "scan", Path: root, Err: os.ErrInvalid}
	}

	threads := opts.Threads
	if threads <= 0 {
		threads = runtime.NumCPU()
	}
	if threads < 1 {
		threads = 1
	}
	// 目录极深时每个 goroutine 的栈都要留够：Go 的栈会自动增长，
	// 但预分配能省掉一半以上的扩容拷贝。
	sem := make(chan struct{}, threads)

	var raw *rawDir
	var scanErr error
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		raw, scanErr = scanDir(root, root, unixSecs(info), opts, progress, sem)
	}()
	wg.Wait()
	if scanErr != nil {
		return nil, scanErr
	}

	capacity := int(progress.Files.Load() + progress.Dirs.Load())
	return flatten(raw, root, capacity), nil
}

// scanDir 读取一个目录，并把子目录分派给 goroutine。
//
// 信号量槽位**只覆盖「读目录」这一段**，不覆盖「等子目录」：
// 如果父 goroutine 一边持槽一边申请子任务的槽，并发度为 1 时父子互相等，
// 直接死锁（Go 的调度器不像 rayon 那样会从阻塞的提交方偷任务）。
func scanDir(path, name string, modified uint32, opts ScanOptions, progress *ScanProgress, sem chan struct{}) (*rawDir, error) {
	dir := &rawDir{name: name, modified: modified}
	if progress.IsCancelled() {
		return dir, nil
	}

	sem <- struct{}{}
	entries, err := os.ReadDir(path)
	if err != nil {
		<-sem
		dir.unreadable = true
		progress.Errors.Add(1)
		return dir, nil
	}

	type sub struct {
		path     string
		name     string
		modified uint32
	}
	var subdirs []sub
	var bytes uint64

	for _, entry := range entries {
		if progress.IsCancelled() {
			break
		}
		entryPath := filepath.Join(path, entry.Name())
		info, err := entry.Info()
		if err != nil {
			progress.Errors.Add(1)
			continue
		}
		mtime := unixSecs(info)

		if entry.IsDir() {
			// 目录 junction / 挂载点：跳过，避免循环和重复统计。
			// 文件类重解析点（如 OneDrive 占位文件）仍然计入。
			if isReparsePoint(entryPath) {
				continue
			}
			subdirs = append(subdirs, sub{path: entryPath, name: entry.Name(), modified: mtime})
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			// Windows 上获取文件 ID 需要额外打开文件，代价太高；
			// 硬链接交给 MFT 模式处理（见 mft.go 的说明）。
			continue
		}
		size := fileSize(info, opts)
		bytes += size
		dir.files = append(dir.files, rawFile{name: entry.Name(), size: size, modified: mtime})
	}
	// 读完就释放槽位，下面等子目录时不再占着并发度
	<-sem

	// 批量更新进度：每个目录只做几次原子操作
	progress.Files.Add(uint64(len(dir.files)))
	progress.Bytes.Add(bytes)
	if progress.Dirs.Add(1)%128 == 0 {
		progress.SetCurrent(path)
	}

	// 子目录并行递归。用**定长结果槽**而不是共享 append —— 多个 goroutine
	// 同时往同一个 slice 追加是数据竞争。
	results := make([]*rawDir, len(subdirs))
	var wg sync.WaitGroup
	for i := range subdirs {
		i := i
		s := subdirs[i]
		wg.Add(1)
		go func() {
			defer wg.Done()
			child, err := scanDir(s.path, s.name, s.modified, opts, progress, sem)
			if err != nil {
				return
			}
			results[i] = child
		}()
	}
	wg.Wait()
	for _, child := range results {
		if child != nil {
			dir.dirs = append(dir.dirs, *child)
		}
	}
	return dir, nil
}

// flatten 用显式栈扁平化：父节点总是先于子节点入树，满足 FlatTree 的下标约定。
func flatten(root *rawDir, rootPath string, capacity int) *FlatTree {
	tree := NewFlatTree(max(capacity, 1), capacity*16)
	tree.SetRootPath(rootPath)

	stack := []struct {
		dir    *rawDir
		parent uint32
	}{{root, None}}
	for len(stack) > 0 {
		top := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		flags := FlagDir
		if top.dir.unreadable {
			flags |= FlagUnreadable
		}
		id := tree.Push(top.parent, top.dir.name, 0, top.dir.modified, flags)
		for _, f := range top.dir.files {
			tree.Push(id, f.name, f.size, f.modified, 0)
		}
		// 逆序入栈，使出栈顺序与原目录顺序一致（与 Rust 版 collect 行为一致）
		for i := len(top.dir.dirs) - 1; i >= 0; i-- {
			stack = append(stack, struct {
				dir    *rawDir
				parent uint32
			}{&top.dir.dirs[i], id})
		}
	}

	tree.Finalize()
	return tree
}

// isReparsePoint 查目录是不是重解析点（junction / 符号链接）。
func isReparsePoint(path string) bool {
	attrs, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(path))
	if err != nil {
		return false
	}
	return attrs&fileAttributeReparsePoint != 0
}

// fileSize 取文件占用的大小。Windows 上没有「实际占用」的概念，等同逻辑大小。
func fileSize(info os.FileInfo, _ ScanOptions) uint64 { return uint64(info.Size()) }

func unixSecs(info os.FileInfo) uint32 {
	return uint32(info.ModTime().Unix())
}
