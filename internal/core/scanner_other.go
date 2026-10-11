//go:build !windows

//! 非 Windows 平台的空实现。
//!
//! 本应用的 MFT 直读、盘符枚举、提权判断都是 Windows 特有的，其它平台一律
//! 走并行遍历。保留这些桩是为了让 `go vet ./...` / `go test ./...` 在别的平台上
//! 也能跑通，而不是报「build constraints exclude all Go files」。

package core

import "errors"

// DriveInfo 描述一个可访问的卷。
type DriveInfo struct {
	MountPoint     string `json:"mountPoint"`
	Name           string `json:"name"`
	FileSystem     string `json:"fileSystem"`
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	Removable      bool   `json:"removable"`
}

// ListDrives 在非 Windows 上返回空表（UI 会退回让用户手输路径）。
func ListDrives() []DriveInfo { return nil }

// Walk 在非 Windows 上串行遍历（正确性优先，不做并发优化）。
func Walk(root string, opts ScanOptions, progress *ScanProgress) (*FlatTree, error) {
	var flat func(path, name string, modified uint32) *rawDir
	flat = func(path, name string, modified uint32) *rawDir {
		dir := &rawDir{name: name, modified: modified}
		if progress.IsCancelled() {
			return dir
		}
		entries, err := readDirSorted(path)
		if err != nil {
			dir.unreadable = true
			progress.Errors.Add(1)
			return dir
		}
		var bytes uint64
		for _, entry := range entries {
			info, err := entry.info()
			if err != nil {
				progress.Errors.Add(1)
				continue
			}
			mtime := unixSecs(info)
			if entry.isDir() {
				dir.dirs = append(dir.dirs, *flat(entry.path(), entry.name(), mtime))
				continue
			}
			if entry.isSymlink() {
				continue
			}
			size := fileSize(info, opts)
			bytes += size
			dir.files = append(dir.files, rawFile{name: entry.name(), size: size, modified: mtime})
		}
		progress.Files.Add(uint64(len(dir.files)))
		progress.Bytes.Add(bytes)
		progress.Dirs.Add(1)
		return dir
	}

	info, err := statRoot(root)
	if err != nil {
		return nil, err
	}
	if !info.isDir() {
		return nil, errors.New(root + " 不是目录")
	}
	raw := flat(root, root, unixSecs(info))
	capacity := int(progress.Files.Load() + progress.Dirs.Load())
	return flatten(raw, root, capacity), nil
}

func tryMFT(root string, opts ScanOptions, progress *ScanProgress) (*FlatTree, string, error) {
	if opts.Engine == EngineMft {
		return nil, "", errors.New("MFT 模式仅支持 Windows NTFS")
	}
	progress.ResetCounters()
	return nil, "", nil
}
