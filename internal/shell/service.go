//! 绑定给前端的服务层：一个导出方法对应一个原 Tauri command。
//!
//! 与 Rust 版 `src-tauri/src/commands.rs` 一一对应：
//!
//!	 list_drives       → ListDrives        check_elevation → CheckElevation
//!	 start_scan        → StartScan         scan_progress   → ScanProgress
//!	 cancel_scan       → CancelScan        tree_summary    → TreeSummary
//!	 get_node          → GetNode           get_children    → GetChildren
//!	 node_path         → NodePath          top_files       → TopFiles
//!	 ext_stats         → ExtStats          search          → Search
//!	 export_snapshot   → ExportSnapshot    delete_to_trash → DeleteToTrash
//!	 reveal_in_explorer→ RevealInExplorer
//!
//! MyGo 按类型名给 JS 客户端命名，所以页面里调的是 `DiskLens.listDrives()`。
//! 调用方（useDiskScan.ts）看不到本文件的存在。
//!
//! ## 与 Rust 版的协议差异
//!
//!   - **可选参数变成「传 0」**。Rust 的 `Option<usize>` 在 Go 的位置参数模型里
//!     没有对应物，统一约定：<= 0 一律取默认值（与原 `unwrap_or(..)` 一致），
//!     并保留原有的上限钳制。
//!   - **Option<T> 变成空串**。`engine_used` / `message` 是 `Option<String>`，
//!     Go 侧用 `""` 表示缺省，桥接层 `src/lib/backend.ts` 会还原成 `null`。
//!   - **事件单向**。`scan-finished` 只能是 Go → JS；前端本来也不订阅它
//!     （进度一直是 100ms 轮询），保留只是兼容原协议。

package shell

import (
	"errors"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"disklens/internal/core"
)

// 扫描任务状态。与前端 `BackendStatus` 同名同值。
const (
	StatusIdle      = "idle"
	StatusRunning   = "running"
	StatusDone      = "done"
	StatusCancelled = "cancelled"
	StatusFailed    = "failed"
)

// 快照与分页的默认值 / 上限，沿用 Rust 版的常量。
const (
	defaultSnapshotNodes = 250_000
	maxSnapshotNodes     = 2_000_000
	defaultChildrenLimit = 500
	defaultTopFilesLimit = 100
	defaultExtStatsLimit = 500
	defaultSearchLimit   = 500
	maxQueryLimit        = 10_000

	errNoTree   = "尚未完成扫描"
	errNoNode   = "节点不存在"
	errNoDelete = "无法删除该项目"
	errRunning  = "已有扫描正在进行"
)

// ScanFinished 是扫描结束时广播的事件负载。
type ScanFinished struct {
	Status     string            `json:"status"`
	Root       string            `json:"root"`
	EngineUsed string            `json:"engineUsed"`
	Message    string            `json:"message"`
	Summary    *core.TreeSummary `json:"summary"`
}

// ProgressDto 是进度快照。Rust 版用 `#[serde(flatten)]` 把计数器和状态并到一个
// 结构体里，Go 侧直接摊平成一个结构 —— 前端看到的 JSON 形状完全一致。
type ProgressDto struct {
	Status     string `json:"status"`
	Root       string `json:"root"`
	ElapsedMs  uint64 `json:"elapsedMs"`
	EngineUsed string `json:"engineUsed"`
	Message    string `json:"message"`

	Files        uint64 `json:"files"`
	Dirs         uint64 `json:"dirs"`
	Bytes        uint64 `json:"bytes"`
	Errors       uint64 `json:"errors"`
	RecordsDone  uint64 `json:"recordsDone"`
	RecordsTotal uint64 `json:"recordsTotal"`
	CurrentPath  string `json:"currentPath"`
}

// ElevationInfo 是后端探测的提权状态。
type ElevationInfo struct {
	// Elevated 报是否已提升。
	Elevated bool `json:"elevated"`
	// Hint 是一句面向用户的话。
	Hint string `json:"hint"`
}

// DeleteResult 是「移到回收站」的结果。
type DeleteResult struct {
	Path       string `json:"path"`
	FreedBytes uint64 `json:"freedBytes"`
	FreedFiles uint32 `json:"freedFiles"`
}

// scanFinishedEvent 是扫描结束事件。
var scanFinishedEvent = mygo.NewEvent[ScanFinished]("scan-finished")

// job 是一次扫描任务的运行时状态。
type job struct {
	progress *core.ScanProgress
	started  time.Time
	root     string
	status   string
	// 以下四个字段只在任务结束后写入，读侧靠 jobMu 保护。
	engineUsed string
	message    string
	elapsedMs  uint64
}

func (j *job) elapsed() uint64 {
	if j.status != StatusRunning {
		return j.elapsedMs
	}
	return uint64(time.Since(j.started).Milliseconds())
}

// DiskLens 是被绑定的服务。
type DiskLens struct {
	// tree 在查询时加读锁、删除到回收站时加写锁。
	treeMu sync.RWMutex
	tree   *core.FlatTree

	jobMu sync.Mutex
	job   *job
}

// New 建服务。
func New() *DiskLens { return &DiskLens{} }

// withTree 取当前树的读锁视图。没有树时返回 errNoTree —— 调用点全是「先把
// fn(tree) 结果算出来再判错」的形式，所以这里返回零值 + false。
func (d *DiskLens) withTree(fn func(*core.FlatTree) error) error {
	d.treeMu.RLock()
	defer d.treeMu.RUnlock()
	if d.tree == nil {
		return errors.New(errNoTree)
	}
	return fn(d.tree)
}

/* ---------------- 磁盘与权限 ---------------- */

// ListDrives 列出本机可读容量的卷。
func (d *DiskLens) ListDrives() ([]core.DriveInfo, error) { return core.ListDrives(), nil }

// CheckElevation 报当前进程是否以管理员身份运行。
//
// MFT 模式要直读 `$MFT`，没有提升权限会静默回退到并行遍历，整卷扫描慢一个
// 数量级。前端据此在界面上明确提示「以管理员身份重启」，而不是让用户从扫描
// 速度里慢慢猜。
func (d *DiskLens) CheckElevation() (ElevationInfo, error) { return elevationInfo(), nil }

/* ---------------- 扫描任务 ---------------- */

// StartScan 启动扫描，立即返回。完成时广播 `scan-finished`。
//
// engine 传 "" 等价于 "auto"（与 Rust 的 `unwrap_or(Engine::Auto)` 一致）；
// threads 传 0 表示用满全部逻辑核心。
func (d *DiskLens) StartScan(path, engine string, threads int) error {
	progress := &core.ScanProgress{}
	j := &job{progress: progress, started: time.Now(), root: path, status: StatusRunning}

	d.jobMu.Lock()
	if d.job != nil && d.job.status == StatusRunning {
		d.jobMu.Unlock()
		return errors.New(errRunning)
	}
	d.job = j
	d.jobMu.Unlock()

	// 先释放上一次的树：千万级节点的树能有几百 MB，两棵并存会直接把内存打满。
	d.treeMu.Lock()
	d.tree = nil
	d.treeMu.Unlock()

	opts := core.DefaultScanOptions()
	if engine != "" {
		opts.Engine = core.ParseEngine(engine)
	}
	opts.Threads = threads

	// Go 的 goroutine 栈会自动增长，不像 Rust 那样要手动 stack_size(64MB)，
	// 所以这里直接起一个即可。
	go d.runScan(j, opts)
	return nil
}

// runScan 是后台扫描 goroutine：跑完 Scan，落地结果、更新任务状态、广播事件。
func (d *DiskLens) runScan(j *job, opts core.ScanOptions) {
	outcome, err := core.Scan(j.root, opts, j.progress)

	status := StatusDone
	engineUsed := ""
	message := ""
	var summary *core.TreeSummary

	switch {
	case err == nil:
		s := core.Summary(outcome.Tree)
		summary = &s
		if outcome.Cancelled {
			status = StatusCancelled
		}
		engineUsed = string(outcome.EngineUsed)
		message = outcome.FallbackReason
		d.treeMu.Lock()
		d.tree = outcome.Tree
		d.treeMu.Unlock()
	case errors.Is(err, core.ErrCancelled):
		// 只有 MFT 模式会走到这里：它在读到一半时直接放弃，不产出部分结果。
		// 并行遍历模式下「取消」是软停止 —— 已扫到的部分照样返回给界面。
		status = StatusCancelled
		message = "扫描已取消"
	default:
		status = StatusFailed
		message = err.Error()
	}

	d.jobMu.Lock()
	// 只有仍是当前任务时才写回：用户可能在扫描刚结束时又发起了新扫描。
	if d.job == j {
		j.status = status
		j.engineUsed = engineUsed
		j.message = message
		j.elapsedMs = uint64(time.Since(j.started).Milliseconds())
	}
	d.jobMu.Unlock()

	// 没有订阅者时 Broadcast 返回错误，忽略即可 —— 前端目前是轮询的。
	_ = scanFinishedEvent.Broadcast(ScanFinished{
		Status:     status,
		Root:       j.root,
		EngineUsed: engineUsed,
		Message:    message,
		Summary:    summary,
	})
}

// ScanProgress 返回当前任务状态与原子计数器快照。
func (d *DiskLens) ScanProgress() ProgressDto {
	d.jobMu.Lock()
	defer d.jobMu.Unlock()
	if d.job == nil {
		return ProgressDto{Status: StatusIdle}
	}
	j := d.job

	dto := ProgressDto{
		Status:     j.status,
		Root:       j.root,
		ElapsedMs:  j.elapsed(),
		EngineUsed: j.engineUsed,
		Message:    j.message,
	}
	s := j.progress.Snapshot()
	dto.Files = s.Files
	dto.Dirs = s.Dirs
	dto.Bytes = s.Bytes
	dto.Errors = s.Errors
	dto.RecordsDone = s.RecordsDone
	dto.RecordsTotal = s.RecordsTotal
	dto.CurrentPath = s.CurrentPath
	return dto
}

// CancelScan 请求取消当前扫描。任务本身仍在后台收尾，界面靠轮询看到状态变化。
func (d *DiskLens) CancelScan() {
	d.jobMu.Lock()
	j := d.job
	d.jobMu.Unlock()
	if j != nil {
		j.progress.Cancel()
	}
}

/* ---------------- 查询 ---------------- */

// TreeSummary 返回整棵树的汇总。
func (d *DiskLens) TreeSummary() (core.TreeSummary, error) {
	var out core.TreeSummary
	err := d.withTree(func(tree *core.FlatTree) error {
		out = core.Summary(tree)
		return nil
	})
	return out, err
}

// GetNode 取单个节点信息。
func (d *DiskLens) GetNode(id uint32) (core.NodeInfo, error) {
	var out core.NodeInfo
	err := d.withTree(func(tree *core.FlatTree) error {
		info, ok := core.NodeInfoOf(tree, id)
		if !ok {
			return errors.New(errNoNode)
		}
		out = info
		return nil
	})
	return out, err
}

// GetChildren 分页取子项（已按大小降序）。limit 传 0 取默认 500。
func (d *DiskLens) GetChildren(id uint32, offset, limit int) ([]core.NodeInfo, error) {
	if limit <= 0 {
		limit = defaultChildrenLimit
	}
	if limit > maxQueryLimit {
		limit = maxQueryLimit
	}
	if offset < 0 {
		offset = 0
	}
	var out []core.NodeInfo
	err := d.withTree(func(tree *core.FlatTree) error {
		out = core.ChildrenPage(tree, id, offset, limit)
		return nil
	})
	return out, err
}

// NodePath 返回节点的完整路径。
func (d *DiskLens) NodePath(id uint32) (string, error) {
	var out string
	err := d.withTree(func(tree *core.FlatTree) error {
		if !tree.Contains(id) {
			return errors.New(errNoNode)
		}
		out = tree.Path(id)
		return nil
	})
	return out, err
}

// TopFiles 返回全盘最大的若干个文件。limit 传 0 取默认 100。
func (d *DiskLens) TopFiles(limit int) ([]core.FileHit, error) {
	if limit <= 0 {
		limit = defaultTopFilesLimit
	}
	if limit > maxQueryLimit {
		limit = maxQueryLimit
	}
	var out []core.FileHit
	err := d.withTree(func(tree *core.FlatTree) error {
		out = core.TopFilesOf(tree, limit)
		return nil
	})
	return out, err
}

// ExtStats 按扩展名汇总。limit 传 0 取默认 500。
func (d *DiskLens) ExtStats(limit int) ([]core.ExtStat, error) {
	if limit <= 0 {
		limit = defaultExtStatsLimit
	}
	var out []core.ExtStat
	err := d.withTree(func(tree *core.FlatTree) error {
		stats := tree.ExtStats()
		if limit < len(stats) {
			stats = stats[:limit]
		}
		out = stats
		return nil
	})
	return out, err
}

// Search 按文件名子串搜索。limit 传 0 取默认 500。
func (d *DiskLens) Search(query string, limit int) ([]core.FileHit, error) {
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxQueryLimit {
		limit = maxQueryLimit
	}
	var out []core.FileHit
	err := d.withTree(func(tree *core.FlatTree) error {
		out = core.SearchOf(tree, query, limit)
		return nil
	})
	return out, err
}

// ExportSnapshot 导出剪枝快照（紧凑二进制，前端解成 ArrayBuffer）。
//
// **MyGo 会把 []byte 序列化成 base64 字符串**，不是 Tauri 的 ArrayBuffer；
// `src/lib/backend.ts` 里的 `fromBase64()` 负责还原。maxNodes 传 0 取默认 25 万。
func (d *DiskLens) ExportSnapshot(maxNodes int) ([]byte, error) {
	if maxNodes <= 0 {
		maxNodes = defaultSnapshotNodes
	}
	if maxNodes > maxSnapshotNodes {
		maxNodes = maxSnapshotNodes
	}
	var out []byte
	err := d.withTree(func(tree *core.FlatTree) error {
		out = core.ExportSnapshot(tree, maxNodes)
		return nil
	})
	return out, err
}

/* ---------------- 破坏性操作 ---------------- */

// DeleteToTrash 把节点移到回收站，并从树中移除、同步更新所有祖先的大小。
func (d *DiskLens) DeleteToTrash(id uint32) (DeleteResult, error) {
	d.treeMu.Lock()
	defer d.treeMu.Unlock()
	if d.tree == nil {
		return DeleteResult{}, errors.New(errNoTree)
	}
	tree := d.tree
	if id == 0 || !tree.Contains(id) || tree.IsDeleted(id) {
		return DeleteResult{}, errors.New(errNoDelete)
	}

	path := tree.Path(id)
	if err := mygo.Shell.TrashItem(path); err != nil {
		return DeleteResult{}, errors.New("移到回收站失败：" + err.Error())
	}
	freedBytes, freedFiles, _ := tree.RemoveSubtree(id)
	return DeleteResult{Path: path, FreedBytes: freedBytes, FreedFiles: freedFiles}, nil
}

// RevealInExplorer 在系统文件管理器中定位该项目。
func (d *DiskLens) RevealInExplorer(id uint32) error {
	var path string
	err := d.withTree(func(tree *core.FlatTree) error {
		if !tree.Contains(id) {
			return errors.New(errNoNode)
		}
		path = tree.Path(id)
		return nil
	})
	if err != nil {
		return err
	}
	mygo.Shell.ShowItemInFolder(path)
	return nil
}
