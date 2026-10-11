import { defineConfig } from "mygo-cli";

/**
 * DiskLens —— Go + MyGo 外壳配置。
 *
 * MyGo 自己没有窗口配置文件 —— 主窗口（1360×860，最小 960×600）在 main.go 里用
 * mygo.NewWindow 创建，这里只管打包：名字、图标、构建命令、生成的 TS 绑定。
 */
export default defineConfig({
  name: "DiskLens",
  identifier: "com.disklens.desktop",
  version: "0.1.0",
  // 源图标原封不动从 src-tauri/icons/icon.png 搬过来（同一份 PNG，字节一致）。
  icon: "icon.png",

  // 前端是 src/ 里那份既有的 Vite + Preact 应用，除了桥接层外一行没动。
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
});