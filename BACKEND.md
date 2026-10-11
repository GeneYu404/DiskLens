# DiskLens 后端（Go 1.27 + MyGo 3）

```
.
├── go.mod                         # module disklens
├── main.go                        # MyGo 桌面壳入口（唯一的窗口在这里建）
├── mygo.config.ts                 # MyGo 打包配置
├── internal/
│   ├── core/                      # 扫描核心库（与 UI 无关，CLI 与桌面壳共用）
│   │   ├── engine.go              # 入口：引擎选择 / 自动回退 / 原子进度
│   │   ├── scanner_windows.go     # goroutine 并行目录遍历（通用）
│   │   ├── mft_parse.go           # NTFS $MFT 直读解析（Windows，需管理员）
│   │   ├── mft_windows.go         # 打开 \\.\X: 原始卷、tryMFT 三态返回
│   │   ├── tree.go                # 扁平树（uint32 下标代替指针）
│   │   ├── query.go               # 分页 / Top-N / 搜索 / 剪枝快照
│   │   ├── drives_windows.go      # 磁盘列表（零第三方依赖）
│   │   └── helpers.go             # 小工具
│   └── shell/                     # 绑定给前端的 MyGo 服务（15 个方法）
├── cmd/disklens/                  # 命令行版本
└── src/                           # React 前端（浏览器中为演示模式）
```

> 2026-10-11 从 Tauri 2 + Rust 整体重写而来，Rust 版（`crates/`、`src-tauri/`、`Cargo.toml`）
> 已删除。下面每一节都标注了 Go 与 Rust 的对应关系，改之前先看对照。

## 1. 命令行版本（建议先跑这个看速度）

```bash
go run ./cmd/disklens -- C:\ --top 20
go run ./cmd/disklens -- ~/projects --engine walk --threads 16
go test ./internal/core/
```

Windows 上**以管理员身份**扫描整个卷（`C:\`）时会自动使用 MFT 模式；
没有权限或不是 NTFS 时自动回退到并行遍历，并打印原因。

## 2. 桌面版（MyGo 3）

```bash
bun install
bun run build:exe        # = mygo build（前端 + mygo 打包），只出 exe 不出安装包
bun run mygo:dev         # 开发（自动拉起 vite）
```

前端用 `mygo-runtime` 的 `isMyGo()` 判断环境：在桌面壳里调用 Go 后端扫描真实磁盘，
在普通浏览器中使用演示数据。要启用 MFT 模式，请以管理员身份启动 DiskLens。

`src/mygo.ts` 是 `mygo generate` 生成的类型化客户端，**不要手改**：
改 Go 侧签名后重跑 `bun run mygo:generate`。

## 3. 扫描引擎

| 引擎 | 适用范围 | 原理 |
|---|---|---|
| `walk` | 所有平台、所有文件系统、任意目录 | 每个目录一个 goroutine 子任务并发递归；信号量只覆盖「读目录」段，不覆盖「等子目录」——否则并发度为 1 时父子互等直接死锁 |
| `mft` | Windows NTFS 整卷，管理员 | 读引导扇区 → 解析 `$MFT` 的 data runs → 4MB 块顺序读取，块内并行解析 FILE 记录 → 按父记录号计数排序 → BFS 建树 |
| `auto` | 默认 | 满足条件时用 `mft`，失败回退 `walk` |

`mft_parse.go` 已处理：更新序列 fixup、碎片化 `$MFT`、扩展记录中的 `$DATA`、硬链接只统计一次、
Win32/POSIX/DOS 命名空间优先级、稀疏运行。暂不处理：命名数据流（ADS）、簇小于 1KB 的卷
（报错后自动回退）。

## 4. 数据结构

```go
type FlatNode struct {
    Size        uint64   // 文件大小 / 子树总大小
    Parent      uint32   // 父节点下标
    FirstChild  uint32   // 子节点按大小降序链接
    NextSibling uint32
    NameOffset  uint32   // 名字存放在共享的 []byte 中
    FileCount   uint32
    Modified    uint32   // Unix 秒
    NameLen     uint16
    Flags       uint16   // 目录 / 已删除 / 无法读取
}
```

Rust 版这里是 `#[repr(C)]` 的 40 字节定长布局并带编译期尺寸断言。**Go 侧刻意不维持**：
Go 侧不需要任何稳定的二进制布局（快照格式 `DLS1` 是独立的自定义编码，不依赖节点布局），
普通 struct 的字段对齐反而更省心。

约定父节点先于子节点插入，`Finalize()` 倒序扫描一次即可自底向上汇总，
再用计数排序建立子节点链表，全程不递归。

## 5. 绑定方法（MyGo 取代 Tauri command）

| Go 方法 | 原 Tauri command | 说明 |
|---|---|---|
| `ListDrives()` | `list_drives` | 磁盘列表（挂载点、文件系统、容量） |
| `CheckElevation()` | `check_elevation` | 提权探测，供界面提示「以管理员身份重启」 |
| `StartScan(path, engine, threads)` | `start_scan` | 后台 goroutine 扫描，立即返回；完成时广播 `scan-finished` 事件 |
| `ScanProgress()` | `scan_progress` | 读取原子计数器（前端每 100ms 调用一次） |
| `CancelScan()` | `cancel_scan` | 设置取消标志 |
| `TreeSummary()` / `GetNode(id)` / `GetChildren(id, offset, limit)` / `NodePath(id)` | 同名 | 查询 |
| `TopFiles(limit)` / `Search(query, limit)` / `ExtStats(limit)` | 同名 | 查询 |
| `ExportSnapshot(maxNodes)` | `export_snapshot` | 二进制剪枝快照；**MyGo 走 base64 字符串**，不是 `ArrayBuffer` |
| `DeleteToTrash(id)` | `delete_to_trash` | 移到回收站并更新树（`mygo.Shell.TrashItem`） |
| `RevealInExplorer(id)` | `reveal_in_explorer` | 在资源管理器中定位（`mygo.Shell.ShowItemInFolder`） |

快照格式（小端，与 Rust 版**逐字节一致**）：
`"DLS1" | count u32 |` 每个节点
`src_id u32 | parent i32 | size f64 | file_count u32 | modified u32 | flags u8 | name_len u16 | name`。

前端解码器在 `src/lib/backend.ts` 的 `decodeSnapshot`，改格式时**两边必须同步改**。

### 与 Rust 版的三处协议差异

1. **可选参数变成「传 0」**。Rust 的 `Option<usize>` 在 Go 的位置参数模型里没有对应物，
   约定 `<= 0` 取默认值（与原 `unwrap_or(..)` 一致），上限钳制不变。
2. **`Option<String>` 变成空串**。`engine_used` / `message` 缺省时 Go 侧给 `""`，
   桥接层在出口处还原成 `null`，组件层类型与语义都没变。
3. **事件是单向的**。`scan-finished` 只能 Go → JS（MyGo 的 JS 运行时只有 `on()`，没有 `emit()`）。
   前端本来就不订阅它（进度一直是轮询），保留只为兼容原协议。

## 6. 下一步

- USN Journal 增量更新：保存 `FSCTL_QUERY_USN_JOURNAL` 的位置，下次启动只应用变化；
- `NtQueryDirectoryFile` + 64KB 缓冲区进一步加速遍历模式；
- 扫描过程中定期导出快照，实现边扫边看。