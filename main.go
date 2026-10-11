//! DiskLens 桌面外壳 —— Go 1.27 + MyGo 3（2026-10-11 从 Tauri 2 + Rust 重写而来，Rust 版已移除）。
//!
//! 单窗口应用：扫描任务在后台 goroutine 里跑，界面每 100ms 轮询一次进度，
//! 完成后按需拉取剪枝快照 —— 与原 Tauri 版同一套节奏。
//!
//! React 前端只改了 `src/lib/backend.ts` 这一个桥接层，其余一行没动。

package main

import (
	"log"

	"github.com/egoist/mygo"

	"disklens/internal/shell"
)

func main() {
	// 必须在创建窗口、绑定服务之前 —— 之后所有 Go 方法才会被暴露成 IPC。
	mygo.Bind(shell.New())

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:  "DiskLens",
			URL:    "/",
			Width:  1360,
			Height: 860,
			// 与 tauri.conf.json 里 main 窗口的 minWidth/minHeight 对齐。
			MinWidth:  960,
			MinHeight: 600,
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatalf("DiskLens 启动失败: %v", err)
	}
}
