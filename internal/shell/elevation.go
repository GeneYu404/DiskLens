package shell

// elevationHint 是提权状态对应的用户提示文案。两端平台共用一份，
// 只有「能不能提升」这个事实不同。
func elevationHint(elevated bool) string {
	if elevated {
		return "已以管理员身份运行，可使用 MFT 直读模式"
	}
	return "当前不是管理员，整卷扫描会回退到并行遍历（明显更慢）。建议以管理员身份重启 DiskLens。"
}
