//go:build windows

package shell

import "golang.org/x/sys/windows"

// elevationInfo 读进程令牌的 TokenElevation 位。
//
// MFT 直读要打开 `\\.\X:` 原始卷，没有提升权限会失败并静默回退到并行遍历。
// 与 Rust 版同款的取舍：取不到令牌时按「未提升」处理 —— 宁可多提示一次，
// 也不要让用户以为已经在用快路径。
//
// windows 0.62（Rust 侧那个 crate）的坑在 Go 侧不存在了：x/sys 已经封装成
// `Token.IsElevated()`，HANDLE / TokenElevation 的形状差异都吸收在包内。
func elevationInfo() ElevationInfo {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return ElevationInfo{
			Elevated: false,
			Hint:     "无法确认当前权限（读取进程令牌失败）",
		}
	}
	// OpenCurrentProcessToken 返回的是真句柄（不像 GetCurrentProcessToken 那种
	// 伪句柄），必须关掉，否则每次探测都漏一个句柄。
	defer token.Close()

	elevated := token.IsElevated()
	return ElevationInfo{
		Elevated: elevated,
		Hint:     elevationHint(elevated),
	}
}
