# DiskLens · 空间分析器

> ⚠️ **本项目由 AI 协助完成，状态不稳定。** 可能存在尚未发现的缺陷，请自行评估使用风险。

Windows 磁盘空间分析工具，对标 WizTree / Everything 的扫描速度。
Rust 负责扫描（NTFS `$MFT` 直读 / rayon 并行遍历），Tauri 2 承载 React 前端。

## 功能

| 视图 | 说明 |
| --- | --- |
| **概览** | 扫描进度、吞吐速率、节点数统计 |
| **磁盘地图** | Treemap 空间热力图，四种着色：按类型 / 按分类 / 按层级深度 / 按修改时间 |
| **文件列表** | 树形列表，懒加载子项，容器查询响应式收列 |
| **最大文件** | Top-N 大文件排行 |
| **文件类型** | 按扩展名聚合分类统计 |
| **性能模型** | 扫描引擎基准对比（`walk` vs `mft`） |

后端架构与实现要点见 [BACKEND.md](BACKEND.md)。

## 扫描引擎

| 引擎 | 适用范围 | 原理 |
| --- | --- | --- |
| `walk` | 所有平台、所有文件系统、任意目录 | 每目录一个 rayon 任务，Windows 上直接用 `FindNextFileW` 的元数据，不额外 `stat` |
| `mft` | Windows NTFS 整卷，**需管理员** | 读引导扇区 → 解析 `$MFT` 的 data runs → 4MB 块顺序读取 → 按父记录号计数排序 → BFS 建树 |
| `auto` | 默认 | 满足条件用 `mft`，失败自动回退 `walk` 并打印原因 |

`mft` 已处理：更新序列 fixup、碎片化 `$MFT`、扩展记录中的 `$DATA`、硬链接只统计一次、
Win32/POSIX/DOS 命名空间优先级、稀疏运行。暂不处理：命名数据流（ADS）、簇小于 1KB 的卷。

## 环境要求

- Windows 10 / 11
- [Bun](https://bun.sh) 1.4+（包管理与脚本）
- Rust 1.98+（MSVC 工具链）
- [Tauri 依赖](https://tauri.app/start/prerequisites/)：MSVC Build Tools、WebView2 Runtime
- **扫描整个卷需要以管理员身份启动**（MFT 模式要求）

## 构建与运行

```bash
bun install

bun run dev          # 前端开发服务器（浏览器中为演示数据）
bun run typecheck    # tsc --noEmit
bun run build:exe    # 产出 src-tauri/target/release/disklens.exe
```

**只出 exe，不打安装包**。需要安装包时用 `bun run tauri build`。

首次克隆后若缺图标，用 `bun run tauri icon src-tauri/app-icon.svg` 生成 `src-tauri/icons/*`。

## 目录结构

```
crates/
├── disklens-core/            # 扫描核心库（与 UI 无关）
│   └── src/
│       ├── engine.rs         # 引擎选择 / 自动回退 / 原子进度
│       ├── scanner.rs        # rayon 并行目录遍历
│       ├── mft.rs            # NTFS $MFT 直读（Windows，需管理员）
│       ├── tree.rs           # 40 字节/节点的扁平树
│       ├── query.rs          # 分页 / Top-N / 搜索 / 剪枝快照
│       └── drives.rs         # 磁盘列表
└── disklens-cli/             # 命令行版本

src-tauri/                    # Tauri 2 桌面壳（IPC 命令）
src/                          # React 前端
├── bridge/                   # ——（无，数据直接走 tauri invoke）
├── components/               # Treemap / TreeList / TopFiles / Extension / Benchmark / PlanPanel / RustCodeViewer
│   └── ui/                   # Fluent 基础组件
├── lib/                      # tree / treemap / format / useDiskScan
└── index.css                 # Windows 11 Fluent 设计令牌（明暗两套）
```

命令行版本：

```bash
cargo run -p disklens-cli --release -- C:\ --top 20
cargo test -p disklens-core
```

## 设计说明

界面走 Windows 11 Fluent 设计体系，与 [lumina](https://github.com/GeneYu404/lumina)、
[PickScreen](https://github.com/GeneYu404/PickScreen) 同一套令牌（`src/index.css`），自动跟随系统深浅色。

**图表色独立成族**：Treemap 的分类色 / 时序色是数据编码而非界面色，单列为 `dataviz-*` 令牌族，
深色模式下准备了降饱和变体（亮色底上的 400 级色在深底上会发飘）。

数据色以 `var(--x)` 形式定义，在 inline `style={{ color }}` 中原生生效并自动跟随主题；
**Canvas 2D 不解析 `var()`**，因此 Treemap 在绘制前用 `resolveCssColor` 统一解析一次。

## 隐私

所有扫描与数据处理均在本机完成，不上传任何数据。
