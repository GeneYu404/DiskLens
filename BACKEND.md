# DiskLens 后端（Rust）

```
.
├── Cargo.toml                    # workspace
├── crates/
│   ├── disklens-core/            # 扫描核心库（与 UI 无关）
│   │   └── src/
│   │       ├── engine.rs         # 入口：引擎选择 / 自动回退 / 原子进度
│   │       ├── scanner.rs        # rayon 并行目录遍历（通用）
│   │       ├── mft.rs            # NTFS $MFT 直读（Windows，需管理员）
│   │       ├── tree.rs           # 40 字节/节点的扁平树
│   │       ├── query.rs          # 分页 / Top-N / 搜索 / 剪枝快照
│   │       └── drives.rs         # 磁盘列表
│   └── disklens-cli/             # 命令行版本
├── src-tauri/                    # Tauri 2 桌面壳（IPC 命令）
└── src/                          # React 前端（浏览器中为演示模式）
```

## 1. 命令行版本（建议先跑这个看速度）

```bash
cargo run -p disklens-cli --release -- C:\ --top 20
cargo run -p disklens-cli --release -- ~/projects --engine walk --threads 16
cargo test -p disklens-core
```

Windows 上**以管理员身份**打开终端扫描整个卷（`C:\`）时会自动使用 MFT 模式；
没有权限或不是 NTFS 时自动回退到并行遍历，并打印原因。

## 2. 桌面版（Tauri 2）

```bash
npm install
npm install -D @tauri-apps/cli@2
npx tauri icon src-tauri/app-icon.svg   # 首次：生成 src-tauri/icons/*
npx tauri dev                           # 开发
npx tauri build                         # 打包
```

前端会检测 `window.__TAURI_INTERNALS__`：在 Tauri 中调用 Rust 后端扫描真实磁盘，
在普通浏览器中使用演示数据。要启用 MFT 模式，请以管理员身份启动 DiskLens。

## 3. 扫描引擎

| 引擎 | 适用范围 | 原理 |
|---|---|---|
| `walk` | 所有平台、所有文件系统、任意目录 | 每个目录一个 rayon 任务，子目录 `into_par_iter` 递归；Windows 上直接用 `FindNextFileW` 返回的元数据，不额外 `stat` |
| `mft` | Windows NTFS 整卷，管理员 | 读引导扇区 → 解析 `$MFT` 的 data runs → 4MB 块顺序读取，块内并行解析 FILE 记录 → 按父记录号计数排序 → BFS 建树 |
| `auto` | 默认 | 满足条件时用 `mft`，失败回退 `walk` |

`mft.rs` 已处理：更新序列 fixup、碎片化 `$MFT`、扩展记录中的 `$DATA`、硬链接只统计一次、
Win32/POSIX/DOS 命名空间优先级、稀疏运行。暂不处理：命名数据流（ADS）、簇小于 1KB 的卷
（报错后自动回退）。

## 4. 数据结构

```rust
#[repr(C)]
pub struct FlatNode {      // 40 字节，编译期断言
    size: u64,             // 文件大小 / 子树总大小
    parent: u32,
    first_child: u32,      // 子节点按大小降序链接
    next_sibling: u32,
    name_offset: u32,      // 名字存放在共享的 Vec<u8> 中
    file_count: u32,
    modified: u32,         // Unix 秒
    name_len: u16,
    flags: u16,            // 目录 / 已删除 / 无法读取
}
```

约定父节点先于子节点插入，`finalize()` 倒序扫描一次即可自底向上汇总，
再用计数排序建立子节点链表，全程不递归。

## 5. IPC 命令

| 命令 | 说明 |
|---|---|
| `list_drives` | 磁盘列表（挂载点、文件系统、容量） |
| `start_scan { path, engine, threads }` | 后台线程扫描，立即返回；完成时发出 `scan-finished` 事件 |
| `scan_progress` | 读取原子计数器（前端每 100ms 调用一次） |
| `cancel_scan` | 设置取消标志，各任务很快退出 |
| `get_children { id, offset, limit }` | 懒加载子项（已排序） |
| `top_files { limit }` / `search { query, limit }` / `ext_stats { limit }` | 查询 |
| `export_snapshot { maxNodes }` | 二进制剪枝快照（ArrayBuffer），较小项合并为「其余 N 个文件」 |
| `delete_to_trash { id }` | 移到回收站并更新树 |
| `reveal_in_explorer { id }` | 在资源管理器中定位 |

快照格式（小端）：`"DLS1" | count u32 |` 每个节点
`src_id u32 | parent i32 | size f64 | file_count u32 | modified u32 | flags u8 | name_len u16 | name`。

## 6. 下一步

- USN Journal 增量更新：保存 `FSCTL_QUERY_USN_JOURNAL` 的位置，下次启动只应用变化；
- `NtQueryDirectoryFile` + 64KB 缓冲区进一步加速遍历模式；
- 扫描过程中定期导出快照，实现边扫边看。
