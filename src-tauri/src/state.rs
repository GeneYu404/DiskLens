//! 应用全局状态：当前扫描任务 + 最近一次扫描得到的目录树。

use disklens_core::{Engine, FlatTree, ScanProgress};
use serde::Serialize;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

#[derive(Default)]
pub struct AppState {
    pub inner: Arc<Shared>,
}

#[derive(Default)]
pub struct Shared {
    /// 查询时加读锁，删除到回收站时加写锁。
    pub tree: RwLock<Option<FlatTree>>,
    pub job: Mutex<Option<Job>>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Idle,
    Running,
    Done,
    Cancelled,
    Failed,
}

pub struct Job {
    pub progress: Arc<ScanProgress>,
    pub started: Instant,
    pub root: String,
    pub status: JobStatus,
    pub engine_used: Option<Engine>,
    pub message: Option<String>,
    pub elapsed_ms: Option<u64>,
}

impl Job {
    pub fn new(root: String, progress: Arc<ScanProgress>) -> Self {
        Self {
            progress,
            started: Instant::now(),
            root,
            status: JobStatus::Running,
            engine_used: None,
            message: None,
            elapsed_ms: None,
        }
    }

    pub fn finish(&mut self, status: JobStatus, engine_used: Option<Engine>, message: Option<String>) {
        self.status = status;
        self.engine_used = engine_used;
        self.message = message;
        self.elapsed_ms = Some(self.elapsed_ms());
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.elapsed_ms.unwrap_or_else(|| self.started.elapsed().as_millis() as u64)
    }
}
