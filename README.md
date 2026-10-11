# DiskLens · 空间分析器

> ⚠️ **本项目由 AI 协助完成，状态不稳定。** 可能存在尚未发现的缺陷，请自行评估使用风险。

Windows 磁盘空间分析工具，对标 WizTree / Everything 的扫描速度。
Go 负责扫描（NTFS `$MFT` 直读 / goroutine 并行遍历），MyGo 3 承载 React 前端。

> 2026-10-11 从 Tauri 2 + Rust 整体重写为 Go 1.27 + MyGo 3（零 CGO）。
> Rust 版（`crates/`、`src-tauri/`）已删除，`Cargo.toml` / `Cargo.lock` 不再存在。
> 前后端协议与迁移对照见 [BACKEND.md](BACKEND.md) 与 [AGENTS.md](AGENTS.md) §0。

## 功能

| 视图 | 说明 |
| --- | --- |
| **概览** | 扫描进度、吞吐速率、节点数统计 |
| **磁盘地图** | Treemap 空间热力图，四种着色：按类型 / 按分类 / 按层级深度 / 按修改时间 |
| **文件列表** | 树形列表，懒加载子项，容器查询响应式收列 |
| **最大文件** | Top-N 大文件排行 |
| **文件类型** | 按扩展名聚合分类统计 |
| **性能模型** | 扫描引擎基准对比（`walk` vs `mft`） |

## 扫描引擎

| 引擎 | 适用范围 | 原理 |
| --- | --- | --- |
| `walk` | 所有平台、所有文件系统、任意目录 | 每目录一个 goroutine 子任务并发递归；信号量只覆盖「读目录」段，不覆盖「等子目录」——否则并发度为 1 时父子互等直接死锁 |
| `mft` | Windows NTFS 整卷，**需管理员** | 读引导扇区 → 解析 `$MFT` 的 data runs → 4MB 块顺序读取 → 按父记录号计数排序 → BFS 建树 |
| `auto` | 默认 | 满足条件用 `mft`，失败自动回退 `walk` 并打印原因 |

`mft` 已处理：更新序列 fixup、碎片化 `$MFT`、扩展记录中的 `$DATA`、硬链接只统计一次、
Win32/POSIX/DOS 命名空间优先级、稀疏运行。暂不处理：命名数据流（ADS）、簇小于 1KB 的卷。

## 环境要求

- Windows 10 / 11
- [Bun](https://bun.sh) 1.4+（包管理与脚本）
- Go 1.27+
- WebView2 Runtime（MyGo 用它承载前端）
- **扫描整个卷需要以管理员身份启动**（MFT 模式要求）

没有 CGO，不需要 Visual Studio Build Tools。Go 侧依赖只有 `mygo` 与 `golang.org/x/sys` 两个。

## 构建与运行

```bash
bun install

bun run dev          # 前端开发服务器（浏览器中为演示数据）
bun run typecheck    # tsc --noEmit
bun run build:exe    # mygo build → build/portable/DiskLens.exe
bun run mygo:dev     # 桌面壳开发模式（自动拉起 vite）
```

**只出 exe，不打安装包**。`bun run build:exe` 会把 NSIS 安装包剔掉，只留 exe 到
`build/portable/`。交付的 exe 请复制到 `D:\Tool\`（见 AGENTS.md §3）。

改 Go 代码后必须跑通这六条：

```bash
bun run typecheck
gofmt -l .                    # 必须无输出
go vet ./...
CGO_ENABLED=0 go build ./...  # 零 CGO 是硬约束
go test ./...
bun run build:exe
```

## 目录结构

```
main.go                          # MyGo 桌面壳入口（唯一的窗口在这里建）
mygo.config.ts                   # MyGo 打包配置
internal/
├── core/                        # 扫描核心库（与 UI 无关，CLI 与桌面壳共用）
│   ├── engine.go                # 引擎选择 / 自动回退 / 原子进度
│   ├── scanner_windows.go       # goroutine 并行目录遍历
│   ├── mft_parse.go             # NTFS $MFT 直读解析
│   ├── tree.go                  # 扁平树（uint32 下标代替指针）
│   ├── query.go                 # 分页 / Top-N / 搜索 / 剪枝快照
│   └── drives_windows.go        # 磁盘列表
└── shell/                       # 绑定给前端的 MyGo 服务（15 个方法）

cmd/disklens/                    # 命令行版本

src/                             # React 前端
├── mygo.ts                      # mygo generate 生成，勿手改
├── components/                  # Treemap / TreeList / TopFiles / Extension / Benchmark / PlanPanel / GoCodeViewer
│   └── ui/                      # Fluent 基础组件
├── lib/                         # tree / treemap / format / useDiskScan / backend（唯一的桥接层）
└── index.css                    # Windows 11 Fluent 设计令牌（明暗两套）
```

命令行版本：

```bash
go run ./cmd/disklens -- C:\ --top 20
go test ./internal/core/
```

## 前端桥接

前端与外壳的耦合**只在 `src/lib/backend.ts` 一个文件**。它把 MyGo 的绑定调用包成
原 Tauri 版同名同义的 `backend.*`，`useDiskScan.ts` 及所有组件都不知道底层换过。

三处协议差异（详见 backend.ts 顶部注释）：

1. **二进制走 base64**。MyGo 把 Go 的 `[]byte` 序列化成 base64 字符串，不是 `ArrayBuffer`。
2. **可选值用空串**。Rust 的 `Option<String>` 缺省时给 `""`，桥接层还原成 `null`。
3. **位置参数**。生成的客户端按 Go 方法签名传参，不是 `invoke(name, {...})`。

## 设计说明

界面走 Windows 11 Fluent 设计体系，与 [lumina](https://github.com/GeneYu404/lumina)、
[PickScreen](https://github.com/GeneYu404/PickScreen) 同一套令牌（`src/index.css`），自动跟随系统深浅色。

**图表色独立成族**：Treemap 的分类色 / 时序色是数据编码而非界面色，单列为 `dataviz-*` 令牌族，
深色模式下准备了降饱和变体（亮色底上的 400 级色在深底上会发飘）。

数据色以 `var(--x)` 形式定义，在 inline `style={{ color }}` 中原生生效并自动跟随主题；
**Canvas 2D 不解析 `var()`**，因此 Treemap 在绘制前用 `resolveCssColor` 统一解析一次。

## 隐私

所有扫描与数据处理均在本机完成，不上传任何数据。