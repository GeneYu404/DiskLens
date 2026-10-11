//go:build windows

package core

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// ScanVolume 打开 `\\.\X:` 并扫描整个卷。**需要管理员权限。**
func ScanVolume(letter byte, progress *ScanProgress) (*FlatTree, error) {
	if letter >= 'a' && letter <= 'z' {
		letter -= 'a' - 'A'
	}
	device := `\\.\` + string(letter) + `:`

	// Go 的 os.Open 走的是 Win32 文件名解析，`\\.\X:` 这种原始设备路径要用
	// CreateFile 直接开。共享读写都必须放开：卷上别的程序（索引服务、备份、
	// 甚至本程序自己的 CLI 实例）可能正开着句柄。
	pathPtr, err := windows.UTF16PtrFromString(device)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(
		pathPtr,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return nil, errors.New("读取 $MFT 需要以管理员身份运行")
		}
		return nil, err
	}
	volume := os.NewFile(uintptr(handle), device)
	if volume == nil {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("创建卷句柄失败")
	}
	defer volume.Close()

	return ScanReader(volume, string(letter)+`:\`, progress)
}

// tryMFT 尝试 MFT 直读。三种结局：
//   - (tree, "", nil)   扫成了
//   - (nil, reason, nil) 跳过，reason 是给用户看的说明（可能为空）
//   - (nil, "", err)    硬错误（调用方指定了 mft 引擎，或用户取消）
func tryMFT(root string, opts ScanOptions, progress *ScanProgress) (*FlatTree, string, error) {
	if opts.Engine == EngineWalk {
		return nil, "", nil
	}
	letter, ok := DriveRootLetter(root)
	if !ok {
		if opts.Engine == EngineMft {
			return nil, "", errors.New("MFT 模式只能扫描整个卷，例如 C:\\")
		}
		return nil, "", nil
	}
	tree, err := ScanVolume(letter, progress)
	if err == nil {
		return tree, "", nil
	}
	if errors.Is(err, ErrCancelled) || opts.Engine == EngineMft {
		return nil, "", err
	}
	progress.ResetCounters()
	return nil, "MFT 模式不可用（" + err.Error() + "），已回退到并行遍历", nil
}
