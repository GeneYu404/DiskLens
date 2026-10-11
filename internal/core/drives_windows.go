//go:build windows

//! 列出本机磁盘（盘符 / 挂载点、卷标、文件系统、容量）。
//!
//! 做法是遍历 A~Z 逐个查询，而不是读一遍挂载点表：查询量固定 26 次，
//! 顺序执行也就几毫秒，换来的是不需要任何第三方依赖，也不怕盘符是网络映射。

package core

import (
	"sort"

	"golang.org/x/sys/windows"
)

// DriveInfo 描述一个可访问的卷。
type DriveInfo struct {
	MountPoint     string `json:"mountPoint"`
	Name           string `json:"name"`
	FileSystem     string `json:"fileSystem"`
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	Removable      bool   `json:"removable"`
}

// ListDrives 返回本机所有可读容量的卷，按挂载点排序。
func ListDrives() []DriveInfo {
	var drives []DriveInfo
	for c := 'A'; c <= 'Z'; c++ {
		root := string(c) + `:\`
		var freeToCaller, total, totalFree uint64
		err := windows.GetDiskFreeSpaceEx(windows.StringToUTF16Ptr(root),
			&freeToCaller, &total, &totalFree)
		if err != nil || total == 0 {
			continue
		}
		label, fs := volumeInfo(string(c) + `:`)
		drives = append(drives, DriveInfo{
			MountPoint:     root,
			Name:           label,
			FileSystem:     fs,
			TotalBytes:     total,
			AvailableBytes: freeToCaller,
			Removable:      isRemovable(string(c) + `:`),
		})
	}
	sort.Slice(drives, func(i, j int) bool { return drives[i].MountPoint < drives[j].MountPoint })
	// 同一个挂载点可能被枚举到多次（大小写、尾斜杠差异），保留第一个
	out := drives[:0]
	seen := make(map[string]bool, len(drives))
	for _, d := range drives {
		key := d.MountPoint
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, d)
	}
	return out
}

// volumeInfo 读卷标与文件系统名。两个失败都按空字符串处理 —— 盘符存在但
// 取不到卷标（比如空盘、光驱）是很常见的，不该让整个列表失败。
func volumeInfo(root string) (label, fs string) {
	nameBuf := make([]uint16, 261)
	serial := make([]uint32, 1)
	maxComp := make([]uint32, 1)
	flags := make([]uint32, 1)
	fsBuf := make([]uint16, 261)
	err := windows.GetVolumeInformation(
		windows.StringToUTF16Ptr(root),
		&nameBuf[0], uint32(len(nameBuf)),
		&serial[0], &maxComp[0], &flags[0],
		&fsBuf[0], uint32(len(fsBuf)),
	)
	if err != nil {
		return "", ""
	}
	return windows.UTF16ToString(nameBuf), windows.UTF16ToString(fsBuf)
}

// isRemovable 用 GetDriveType 判断：DRIVE_REMOVABLE / DRIVE_CDROM 算可移动。
func isRemovable(root string) bool {
	t := windows.GetDriveType(windows.StringToUTF16Ptr(root))
	return t == windows.DRIVE_REMOVABLE || t == windows.DRIVE_CDROM
}
