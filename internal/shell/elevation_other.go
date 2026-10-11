//go:build !windows

package shell

// elevationInfo 在非 Windows 平台恒为「已提升」。
//
// 不是撒谎，而是这个平台根本没有 UAC：`tryMFT` 会直接返回「MFT 模式只能扫描
// 整个卷」或退回并行遍历，提权与否不改变任何行为，没必要在界面上报警。
func elevationInfo() ElevationInfo {
	return ElevationInfo{
		Elevated: true,
		Hint:     "非 Windows 平台，无提权概念，始终使用并行遍历",
	}
}
