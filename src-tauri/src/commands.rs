//! 前端可调用的 IPC 命令。
//!
//! 设计原则：扫描在独立线程中进行，前端每 100ms 调用一次 `scan_progress` 读取原子计数器；
//! 扫描完成后，前端只按需获取数据（分页子项、Top-N、剪枝快照），不会一次性传输整棵树。
//!
//! 所有命令都声明为 `async`，在 Tauri 的异步线程池上执行，不阻塞窗口主线程。

use crate::state::{AppState, Job, JobStatus};
use disklens_core::drives::{self, DriveInfo};
use disklens_core::query::{self, FileHit, NodeInfo, TreeSummary};
use disklens_core::tree::ExtStat;
use disklens_core::{Engine, FlatTree, ProgressSnapshot, ScanOptions, ScanProgress};
use serde::Serialize;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;

const NO_TREE: &str = "尚未完成扫描";
const LOCK_POISONED: &str = "内部状态锁已损坏";
const DEFAULT_SNAPSHOT_NODES: usize = 250_000;
const MAX_SNAPSHOT_NODES: usize = 2_000_000;

fn with_tree<T>(state: &State<'_, AppState>, f: impl FnOnce(&FlatTree) -> T) -> CmdResult<T> {
    let guard = state.inner.tree.read().map_err(|_| LOCK_POISONED)?;
    let tree = guard.as_ref().ok_or(NO_TREE)?;
    Ok(f(tree))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDto {
    status: JobStatus,
    root: String,
    elapsed_ms: u64,
    engine_used: Option<Engine>,
    message: Option<String>,
    #[serde(flatten)]
    counters: ProgressSnapshot,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanFinished {
    status: JobStatus,
    root: String,
    engine_used: Option<Engine>,
    message: Option<String>,
    summary: Option<TreeSummary>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    path: String,
    freed_bytes: u64,
    freed_files: u32,
}

#[tauri::command]
pub async fn list_drives() -> CmdResult<Vec<DriveInfo>> {
    Ok(drives::list_drives())
}

/// 启动扫描，立即返回。完成时发出 `scan-finished` 事件。
#[tauri::command]
pub async fn start_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    engine: Option<String>,
    threads: Option<usize>,
) -> CmdResult<()> {
    let shared = state.inner.clone();
    let progress = Arc::new(ScanProgress::default());

    {
        let mut job = shared.job.lock().map_err(|_| LOCK_POISONED)?;
        if matches!(job.as_ref().map(|j| j.status), Some(JobStatus::Running)) {
            return Err("已有扫描正在进行".into());
        }
        *job = Some(Job::new(path.clone(), progress.clone()));
    }
    // 先释放上一次的树，避免两棵树同时占用内存
    if let Ok(mut tree) = shared.tree.write() {
        *tree = None;
    }

    let opts = ScanOptions {
        engine: engine.as_deref().map(Engine::parse).unwrap_or(Engine::Auto),
        threads: threads.unwrap_or(0),
        ..ScanOptions::default()
    };

    std::thread::Builder::new()
        .name("disklens-scan".into())
        .stack_size(64 << 20)
        .spawn(move || {
            let result = disklens_core::scan(&PathBuf::from(&path), &opts, &progress);
            let mut summary = None;

            let (status, engine_used, message) = match result {
                Ok(outcome) => {
                    summary = Some(query::summary(&outcome.tree));
                    let status = if outcome.cancelled { JobStatus::Cancelled } else { JobStatus::Done };
                    let engine_used = outcome.engine_used;
                    let message = outcome.fallback_reason.clone();
                    if let Ok(mut slot) = shared.tree.write() {
                        *slot = Some(outcome.tree);
                    }
                    (status, Some(engine_used), message)
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                    (JobStatus::Cancelled, None, Some("扫描已取消".to_string()))
                }
                Err(e) => (JobStatus::Failed, None, Some(e.to_string())),
            };

            if let Ok(mut job) = shared.job.lock() {
                if let Some(job) = job.as_mut() {
                    job.finish(status, engine_used, message.clone());
                }
            }
            let _ = app.emit("scan-finished", ScanFinished { status, root: path, engine_used, message, summary });
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn scan_progress(state: State<'_, AppState>) -> CmdResult<ProgressDto> {
    let job = state.inner.job.lock().map_err(|_| LOCK_POISONED)?;
    Ok(match job.as_ref() {
        None => ProgressDto {
            status: JobStatus::Idle,
            root: String::new(),
            elapsed_ms: 0,
            engine_used: None,
            message: None,
            counters: ProgressSnapshot::default(),
        },
        Some(job) => ProgressDto {
            status: job.status,
            root: job.root.clone(),
            elapsed_ms: job.elapsed_ms(),
            engine_used: job.engine_used,
            message: job.message.clone(),
            counters: job.progress.snapshot(),
        },
    })
}

#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> CmdResult<()> {
    let job = state.inner.job.lock().map_err(|_| LOCK_POISONED)?;
    if let Some(job) = job.as_ref() {
        job.progress.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn tree_summary(state: State<'_, AppState>) -> CmdResult<TreeSummary> {
    with_tree(&state, query::summary)
}

#[tauri::command]
pub async fn get_node(state: State<'_, AppState>, id: u32) -> CmdResult<NodeInfo> {
    with_tree(&state, |tree| query::node_info(tree, id))?.ok_or_else(|| "节点不存在".to_string())
}

#[tauri::command]
pub async fn get_children(
    state: State<'_, AppState>,
    id: u32,
    offset: Option<usize>,
    limit: Option<usize>,
) -> CmdResult<Vec<NodeInfo>> {
    with_tree(&state, |tree| query::children_page(tree, id, offset.unwrap_or(0), limit.unwrap_or(500).min(10_000)))
}

#[tauri::command]
pub async fn node_path(state: State<'_, AppState>, id: u32) -> CmdResult<String> {
    with_tree(&state, |tree| tree.contains(id).then(|| tree.path(id).to_string_lossy().into_owned()))?
        .ok_or_else(|| "节点不存在".to_string())
}

#[tauri::command]
pub async fn top_files(state: State<'_, AppState>, limit: Option<usize>) -> CmdResult<Vec<FileHit>> {
    with_tree(&state, |tree| query::top_files(tree, limit.unwrap_or(100).min(10_000)))
}

#[tauri::command]
pub async fn ext_stats(state: State<'_, AppState>, limit: Option<usize>) -> CmdResult<Vec<ExtStat>> {
    with_tree(&state, |tree| {
        let mut stats = tree.ext_stats();
        stats.truncate(limit.unwrap_or(500));
        stats
    })
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String, limit: Option<usize>) -> CmdResult<Vec<FileHit>> {
    // 参数名 `query` 会遮蔽同名模块，这里使用完整路径
    with_tree(&state, |tree| disklens_core::query::search(tree, &query, limit.unwrap_or(500).min(10_000)))
}

/// 以二进制返回剪枝快照（前端收到 ArrayBuffer），格式见 `disklens_core::query::export_snapshot`。
#[tauri::command]
pub async fn export_snapshot(state: State<'_, AppState>, max_nodes: Option<usize>) -> CmdResult<tauri::ipc::Response> {
    let limit = max_nodes.unwrap_or(DEFAULT_SNAPSHOT_NODES).clamp(1, MAX_SNAPSHOT_NODES);
    let bytes = with_tree(&state, |tree| query::export_snapshot(tree, limit))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 移到回收站，并从树中移除、更新祖先大小。
#[tauri::command]
pub async fn delete_to_trash(state: State<'_, AppState>, id: u32) -> CmdResult<DeleteResult> {
    let mut guard = state.inner.tree.write().map_err(|_| LOCK_POISONED)?;
    let tree = guard.as_mut().ok_or(NO_TREE)?;
    if id == 0 || !tree.contains(id) || tree.is_deleted(id) {
        return Err("无法删除该项目".into());
    }
    let path = tree.path(id);
    trash::delete(&path).map_err(|e| format!("移到回收站失败：{e}"))?;
    let (freed_bytes, freed_files) = tree.remove_subtree(id).unwrap_or((0, 0));
    Ok(DeleteResult { path: path.to_string_lossy().into_owned(), freed_bytes, freed_files })
}

/// 在系统文件管理器中定位该项目。
#[tauri::command]
pub async fn reveal_in_explorer(state: State<'_, AppState>, id: u32) -> CmdResult<()> {
    let path = with_tree(&state, |tree| tree.contains(id).then(|| tree.path(id)))?.ok_or("节点不存在")?;

    #[cfg(windows)]
    let spawned = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(&path)).spawn();

    spawned.map(|_| ()).map_err(|e| e.to_string())
}
