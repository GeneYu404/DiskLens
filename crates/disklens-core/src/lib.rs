//! # DiskLens Core
//!
//! 高性能磁盘占用分析核心库。
//!
//! 性能上最要紧的三件事：
//!
//! 1. **扫描方式**：[`scanner`] 用 rayon 工作窃取并行遍历目录，所有文件系统都能用；
//!    [`mft`] 在 Windows NTFS 上直接顺序读取 `$MFT`（需要管理员权限）。
//! 2. **数据结构**：[`tree::FlatTree`] 把所有节点放进一个连续数组（40 字节/节点），
//!    用下标代替指针，名字拼接进同一块缓冲区。
//! 3. **界面传输**：[`query`] 提供分页 / Top-N / 剪枝快照，UI 只拿需要显示的那部分。
//!
//! 入口函数是 [`scan`]，它会按 [`Engine`] 自动选择引擎，失败时回退到通用遍历。

pub mod drives;
pub mod engine;
pub mod mft;
pub mod query;
pub mod scanner;
pub mod tree;

pub use engine::{scan, Engine, ProgressSnapshot, ScanOptions, ScanOutcome, ScanProgress};
pub use tree::FlatTree;
