//! 扫描入口：选择引擎、提供进度计数器、统一返回结果。
//!
//!   - EngineAuto：Windows 上扫描整个卷（如 C:\）时先尝试 NTFS $MFT 直读，
//!     失败（没有管理员权限、不是 NTFS……）就回退到并行遍历；
//!   - EngineWalk：总是使用并行遍历，所有平台、所有文件系统都能用；
//!   - EngineMft：只使用 $MFT，失败时直接报错。
//!
//! 进度统一用原子计数器：扫描线程按目录（或按 4MB 块）批量累加，
//! UI 线程每 100ms 读一次 Snapshot，扫描线程永远不会被 UI 阻塞。

package core

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Engine 是扫描引擎。JSON 里用小写字符串表示。
type Engine string

const (
	EngineAuto Engine = "auto"
	EngineWalk Engine = "walk"
	EngineMft  Engine = "mft"
)

// ParseEngine 解析引擎名；认不出来的一律当 auto。
func ParseEngine(value string) Engine {
	switch lowerTrim(value) {
	case "walk", "rayon", "parallel":
		return EngineWalk
	case "mft", "ntfs":
		return EngineMft
	default:
		return EngineAuto
	}
}

// Label 给出面向用户的引擎说明。
func (e Engine) Label() string {
	switch e {
	case EngineWalk:
		return "walk (并行遍历)"
	case EngineMft:
		return "mft (NTFS 元数据直读)"
	default:
		return "auto"
	}
}

func lowerTrim(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			continue
		}
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out = append(out, c)
	}
	return string(out)
}

// ScanOptions 是一次扫描的参数。
type ScanOptions struct {
	Engine Engine
	// Threads 是线程数，0 表示使用全部逻辑核心。
	Threads int
	// SameFilesystem：遍历模式下不跨越挂载点。
	SameFilesystem bool
	// AllocatedSize：统计磁盘实际占用而不是逻辑大小（Unix 有效）。
	AllocatedSize bool
}

// DefaultScanOptions 返回默认参数。
func DefaultScanOptions() ScanOptions {
	return ScanOptions{Engine: EngineAuto, Threads: 0, SameFilesystem: true}
}

// ScanProgress 是扫描线程与 UI 线程共享的进度状态。
type ScanProgress struct {
	CancelFlag atomic.Bool
	Files      atomic.Uint64
	Dirs       atomic.Uint64
	Bytes      atomic.Uint64
	Errors     atomic.Uint64
	// MFT 模式：已读取 / 总记录数。
	RecordsDone  atomic.Uint64
	RecordsTotal atomic.Uint64

	// Done 由**调用方**在扫描返回后置位。CLI 的进度线程靠它退出；
	// UI 侧不用（有自己的生命周期），但留着也无害。
	Done atomic.Bool

	mu      sync.Mutex
	current string
}

// ProgressSnapshot 是给 UI 读的一次进度快照。
type ProgressSnapshot struct {
	Files        uint64 `json:"files"`
	Dirs         uint64 `json:"dirs"`
	Bytes        uint64 `json:"bytes"`
	Errors       uint64 `json:"errors"`
	RecordsDone  uint64 `json:"recordsDone"`
	RecordsTotal uint64 `json:"recordsTotal"`
	CurrentPath  string `json:"currentPath"`
}

// Cancel 请求取消扫描。
func (p *ScanProgress) Cancel() { p.CancelFlag.Store(true) }

// IsCancelled 报是否已请求取消。
func (p *ScanProgress) IsCancelled() bool { return p.CancelFlag.Load() }

// SetCurrent 记录当前路径。拿不到锁就跳过，绝不让扫描线程等待。
func (p *ScanProgress) SetCurrent(path string) {
	// 注意：这里必须用 TryLock 而不是 Lock + TryLock。先 Lock 再 TryLock 的话，
	// 同一 goroutine 第二次加锁必然失败，current 就永远写不进去。
	if p.mu.TryLock() {
		p.current = path
		p.mu.Unlock()
	}
}

// MarkFinished 通知进度观察者（CLI 进度线程）扫描已经结束。
func (p *ScanProgress) MarkFinished() { p.Done.Store(true) }

// IsFinished 报扫描是否已经结束。
func (p *ScanProgress) IsFinished() bool { return p.Done.Load() }

// Snapshot 读一次进度快照。
func (p *ScanProgress) Snapshot() ProgressSnapshot {
	p.mu.Lock()
	cur := p.current
	p.mu.Unlock()
	return ProgressSnapshot{
		Files:        p.Files.Load(),
		Dirs:         p.Dirs.Load(),
		Bytes:        p.Bytes.Load(),
		Errors:       p.Errors.Load(),
		RecordsDone:  p.RecordsDone.Load(),
		RecordsTotal: p.RecordsTotal.Load(),
		CurrentPath:  cur,
	}
}

// ResetCounters 清零所有计数器（MFT 失败回退到遍历模式时用）。
func (p *ScanProgress) ResetCounters() {
	p.Files.Store(0)
	p.Dirs.Store(0)
	p.Bytes.Store(0)
	p.Errors.Store(0)
	p.RecordsDone.Store(0)
	p.RecordsTotal.Store(0)
	p.mu.Lock()
	p.current = ""
	p.mu.Unlock()
}

// ScanOutcome 是一次扫描的结果。
type ScanOutcome struct {
	Tree       *FlatTree
	EngineUsed Engine
	Elapsed    time.Duration
	// FallbackReason：Auto 模式下 MFT 不可用时的原因说明。
	FallbackReason string
	// Cancelled 为 true 时 Tree 是已扫描部分的结果。
	Cancelled bool
}

// ErrCancelled 表示扫描被用户取消。上层据此区分「取消」与「失败」。
var ErrCancelled = errors.New("扫描已取消")

// Scan 扫描 root。**阻塞调用**，请在后台 goroutine 中运行。
func Scan(root string, opts ScanOptions, progress *ScanProgress) (*ScanOutcome, error) {
	started := time.Now()

	// tryMFT 有三种结局：扫成了（tree 非 nil）、跳过（reason 非空）、硬错误。
	tree, reason, err := tryMFT(root, opts, progress)
	if err != nil {
		return nil, err
	}
	if tree != nil {
		return &ScanOutcome{
			Tree:       tree,
			EngineUsed: EngineMft,
			Elapsed:    time.Since(started),
		}, nil
	}

	tree, err = Walk(root, opts, progress)
	if err != nil {
		return nil, err
	}
	return &ScanOutcome{
		Tree:           tree,
		EngineUsed:     EngineWalk,
		Elapsed:        time.Since(started),
		FallbackReason: reason,
		Cancelled:      progress.IsCancelled(),
	}, nil
}
