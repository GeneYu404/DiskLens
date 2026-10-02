import { useEffect, useState } from "react";
import { formatBytes, formatCount, formatMs } from "./lib/format";
import { useDiskScan, type DriveOption, type EngineChoice } from "./lib/useDiskScan";
import TreeList from "./components/TreeList";
import Treemap, { type TreemapColorMode } from "./components/Treemap";
import TopFilesView from "./components/TopFilesView";
import ExtensionView from "./components/ExtensionView";
import BenchmarkView from "./components/BenchmarkView";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Files,
  Gauge,
  HardDrive,
  Info,
  LayoutGrid,
  ListTree,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Square,
  Tags,
  X,
} from "lucide-react";

type ViewMode = "overview" | "map" | "files" | "largest" | "types" | "performance";

const NAV_ITEMS: { id: ViewMode; label: string; icon: typeof LayoutGrid }[] = [
  { id: "overview", label: "概览", icon: LayoutGrid },
  { id: "map", label: "磁盘地图", icon: Database },
  { id: "files", label: "文件列表", icon: ListTree },
  { id: "largest", label: "最大文件", icon: Files },
  { id: "types", label: "文件类型", icon: Tags },
  { id: "performance", label: "性能模型", icon: Gauge },
];

const VIEW_TITLES: Record<ViewMode, string> = {
  overview: "存储分析",
  map: "磁盘地图",
  files: "文件列表",
  largest: "最大文件",
  types: "文件类型",
  performance: "扫描性能",
};

const PLACEHOLDER_DRIVE: DriveOption = {
  drive: "—",
  label: "未检测到磁盘",
  desc: "正在读取磁盘列表…",
  fsType: "—",
  totalCap: 0,
  usedBytes: 0,
  targetFiles: 0,
};

const ENGINE_LABELS: Record<string, string> = {
  mft: "NTFS 元数据直读",
  walk: "并行目录遍历",
  auto: "自动",
};

const SURFACE = "surface";

export default function App() {
  const scan = useDiskScan();
  const { tree, version, stats, drives, status, scanning } = scan;

  const [driveIdx, setDriveIdx] = useState(0);
  const [threads, setThreads] = useState(8);
  const [engine, setEngine] = useState<EngineChoice>("mft");
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [colorMode, setColorMode] = useState<TreemapColorMode>("category");
  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const [selected, setSelected] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [showScanOptions, setShowScanOptions] = useState(false);

  const activeDrive = drives[driveIdx] ?? drives[0] ?? PLACEHOLDER_DRIVE;
  const memoryMB = tree ? (tree.count * 40) / (1024 * 1024) : 0;
  const throughput = scan.elapsed > 0 ? stats.files / (scan.elapsed / 1000) : 0;

  const resetView = () => {
    setExpanded(new Set([0]));
    setSelected(0);
    setCursor(0);
  };

  const startScan = (index = driveIdx) => {
    resetView();
    scan.start(index, engine, threads);
  };

  // 演示模式自动开始；本机模式等待用户选择磁盘
  useEffect(() => {
    if (!scan.native) startScan(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleEnter = (id: number) => {
    setCursor(id);
    setSelected(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      tree?.pathIds(id).forEach((parent) => next.add(parent));
      return next;
    });
  };

  const handleDelete = (id: number) => {
    void scan.deleteNode(id);
  };

  const handleDriveChange = (index: number) => {
    setDriveIdx(index);
    resetView();
    scan.start(index, engine, threads);
  };

  const statusText = scanning
    ? `正在扫描 · ${(scan.progress * 100).toFixed(1)}%`
    : status === "cancelled"
      ? "扫描已停止"
      : status === "failed"
        ? "扫描失败"
        : status === "done"
          ? "分析完成"
          : "就绪";

  const capacityPct = activeDrive.totalCap > 0 ? Math.min(100, (stats.bytes / activeDrive.totalCap) * 100) : 0;
  const diskUsedPct = activeDrive.totalCap > 0 ? Math.min(100, (activeDrive.usedBytes / activeDrive.totalCap) * 100) : 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("disklens-search")?.focus();
      }
      if (event.key === "Escape") {
        setShowScanOptions(false);
        if (document.activeElement?.id === "disklens-search") {
          setSearchQuery("");
          (document.activeElement as HTMLElement).blur();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="fluent-shell app-shell">
      {/* Tauri uses the system title bar. This is the app's own command header. */}
      <div className="titlebar">
        <div className="titlebar-main">
          <div className="app-mark">
            <HardDrive className="i17" strokeWidth={1.9} />
          </div>
          <div className="titlebar-names">
            <span className="app-name">DiskLens</span>
            <span className="app-tagline">空间分析器</span>
          </div>
        </div>
        <div className="titlebar-right">
          <span className="conn-pill" title={scan.native ? "Rust 后端正在处理本机磁盘" : "浏览器中使用模拟数据"}>
            <span className={`dot-6 ${scan.native ? "is-ok" : "is-warn"}`} />
            {scan.native ? "已连接本机" : "演示模式"}
          </span>
          <span className="vrule-16" />
        </div>
      </div>

      <div className="body-row">
        {/* 导航栏 */}
        <aside className="fluent-sidebar sidebar">
          <div className="sidebar-label">浏览</div>
          <nav className="stack-1" aria-label="主导航">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const active = id === viewMode;
              return (
                <button
                  key={id}
                  onClick={() => setViewMode(id)}
                  title={label}
                  className={`fluent-nav-item nav-item ${active ? "nav-item--active" : ""}`}
                >
                  {active && <span className="nav-item-bar" />}
                  <Icon className={`nav-icon ${active ? "u-accent" : ""}`} strokeWidth={1.8} />
                  <span className="nav-text">{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="sidebar-divider" />
          <div className="sidebar-label sidebar-label--tight">磁盘</div>
          <div className="stack-1">
            {drives.map((drive, index) => (
              <button
                key={drive.drive}
                onClick={() => handleDriveChange(index)}
                disabled={scanning}
                title={`${drive.drive} · ${drive.label}`}
                className={`t-colors drive-item ${index === driveIdx ? "drive-item--active" : ""}`}
              >
                <HardDrive className={`drive-icon ${index === driveIdx ? "u-accent" : ""}`} strokeWidth={1.8} />
                <div className="drive-body">
                  <div className="drive-head">
                    <span className="u-font-semibold">{drive.drive}</span>
                    <span className="drive-cap">{formatBytes(drive.totalCap)}</span>
                  </div>
                  <div className="drive-label u-truncate">{drive.label}</div>
                  {drive.usedBytes > 0 && (
                    <div className="meter meter-3">
                      <div className="meter-fill" style={{ width: `${Math.min(100, drive.usedBytes / drive.totalCap * 100)}%` }} />
                    </div>
                  )}
                </div>
              </button>
            ))}
            {drives.length === 0 && <p className="sidebar-note">正在检测磁盘...</p>}
          </div>
        </aside>

        {/* 主内容 */}
        <main className="main-col">
          {/* 未以管理员运行时提醒：MFT 直读需要提权，否则整卷扫描回退到并行遍历会慢一个数量级 */}
          {scan.native && scan.elevated === false && (
            <div role="status" className="notice notice--elevated">
              <ShieldAlert className="notice-icon" aria-hidden="true" />
              <div className="u-min-w-0">
                <span className="notice-body">当前未以管理员身份运行。</span>
                整卷扫描会回退到并行遍历模式，明显更慢。请关闭 DiskLens，右键图标选择「以管理员身份运行」重新启动，即可使用 NTFS $MFT 直读（快一个数量级）。
              </div>
            </div>
          )}
          <header className="page-head">
            <div className="breadcrumb">
              <span>此电脑</span><ChevronRight className="i12" />
              <span>{activeDrive.drive}</span><ChevronRight className="i12" />
              <span className="crumb-current">{VIEW_TITLES[viewMode]}</span>
            </div>
            <div className="head-row">
              <div className="u-min-w-0">
                <div className="head-title-row">
                  <h1 className="page-title">{VIEW_TITLES[viewMode]}</h1>
                  {scan.native && <ShieldCheck className="i17 u-success" aria-label="本机扫描" />}
                </div>
                <p className="page-sub u-truncate">{activeDrive.label} <span className="path-sep">/</span> {activeDrive.fsType} <span className="path-sep">/</span> {formatBytes(activeDrive.totalCap)}</p>
              </div>
              {scanning ? (
                <button onClick={scan.cancel} className="t-all btn-ghost">
                  <Square className="i12 u-danger i-fill-danger" /> 停止扫描
                </button>
              ) : (
                <button onClick={() => startScan()} disabled={drives.length === 0} className="t-all btn-primary btn-primary--fx">
                  {status === "done" ? <RefreshCw className="i14" /> : <Play className="i14 i-fill-current" />}
                  {status === "done" ? "重新扫描" : "开始扫描"}
                </button>
              )}
            </div>
          </header>

          {/* Explorer-like command bar */}
          <div className="cmdbar">
            <label className="search-field">
              <Search className="search-icon" strokeWidth={1.8} />
              <input id="disklens-search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索文件或文件夹" className="search-input" />
              {searchQuery ? <button onClick={() => setSearchQuery("")} className="search-clear" aria-label="清除搜索"><X className="i14" /></button> : <kbd className="kbd-hint">Ctrl K</kbd>}
            </label>
            <div className="u-relative">
              <button onClick={() => setShowScanOptions((v) => !v)} aria-expanded={showScanOptions} className={`t-colors options-btn ${showScanOptions ? "options-btn--open" : ""}`}>
                <Settings2 className="i15" strokeWidth={1.8} /> 扫描选项 <ChevronDown className="i12" />
              </button>
              {showScanOptions && <div className="popover">
                <div className="pop-title">扫描设置</div>
                <p className="pop-note">更改设置后，在下次扫描时生效。</p>
                <label className="pop-label">扫描引擎</label>
                <select value={engine} onChange={(e) => setEngine(e.target.value as EngineChoice)} disabled={scanning} className="pop-select"><option value="mft">自动（优先 NTFS MFT）</option><option value="rayon">并行目录遍历</option></select>
                <label className="pop-label pop-label--tight">工作线程</label>
                <select value={threads} onChange={(e) => setThreads(Number(e.target.value))} disabled={scanning} className="pop-select">{[4, 8, 12, 16, 32].map((n) => <option key={n} value={n}>{n} 线程</option>)}</select>
                <div className="pop-foot"><Info className="i14 u-shrink-0" /> MFT 仅适用于 NTFS 整卷，可能需要管理员权限。</div>
              </div>}
            </div>
            <div className="cmd-divider vrule-16" />
            <span className="cmd-hint">{scan.native ? "真实磁盘" : "演示数据"}</span>
            {scanning && <span className="cmd-live"><span className="dot-6 pulse u-bg-accent" />正在分析 {scan.progress > 0 ? `${(scan.progress * 100).toFixed(0)}%` : "..."}</span>}
            {!scanning && stats.files > 0 && <span className="cmd-note">扫描于 {formatMs(scan.elapsed)} 内完成</span>}
          </div>

          {/* Compact capacity summary, not a dashboard of competing cards */}
          <section className="capacity">
            <div className="capacity-lead">
              <div className="capacity-mark"><HardDrive className="i19" strokeWidth={1.7} /></div>
              <div className="capacity-body">
                <div className="capacity-line"><span className="capacity-value">{formatBytes(stats.bytes)}</span><span className="capacity-sub">已分析 / {formatBytes(activeDrive.totalCap)}</span></div>
                <div className="meter meter-5"><div className="meter-fill meter-fill--slow" style={{ width: `${Math.max(scanning || stats.bytes > 0 ? 1 : 0, capacityPct)}%` }} /></div>
                {scan.native && activeDrive.usedBytes > 0 && <span className="capacity-note">磁盘实际已用 {diskUsedPct.toFixed(0)}%</span>}
              </div>
            </div>
            <Metric label="文件" value={formatCount(stats.files)} />
            <Metric label="文件夹" value={formatCount(stats.dirs)} />
            <Metric label="扫描用时" value={formatMs(scan.elapsed)} />
            <Metric label="处理速度" value={`${formatCount(throughput)}/秒`} />
          </section>

          {scan.message && (
            <div className="alert-strip">
              <AlertTriangle className="i14 u-shrink-0" />
              <span className="u-flex-1">{scan.message}</span>
            </div>
          )}

          {/* 工作区 */}
          <div className="workspace">
            {!tree && viewMode !== "performance" && (
              <EmptyState
                native={scan.native}
                scanning={scanning}
                progress={scan.progress}
                currentPath={scan.currentPath}
                canScan={drives.length > 0}
                onScan={() => startScan()}
              />
            )}

            {tree && viewMode === "overview" && (
              <div className="overview-grid">
                <section className={SURFACE}>
                  <TreeList
                    tree={tree}
                    rootId={0}
                    version={version}
                    expanded={expanded}
                    toggle={handleToggle}
                    selected={selected}
                    searchQuery={searchQuery}
                    onSelect={setSelected}
                    onEnter={handleEnter}
                    onDelete={handleDelete}
                    maxChildren={600}
                  />
                </section>
                <section className={SURFACE}>
                  <Treemap
                    tree={tree}
                    rootId={cursor}
                    version={version}
                    selected={selected}
                    searchQuery={searchQuery}
                    colorMode={colorMode}
                    onSelect={setSelected}
                    onEnter={handleEnter}
                    onDelete={handleDelete}
                    onColorModeChange={setColorMode}
                  />
                </section>
              </div>
            )}

            {tree && viewMode === "map" && (
              <section className={`u-h-full ${SURFACE}`}>
                <Treemap
                  tree={tree}
                  rootId={cursor}
                  version={version}
                  selected={selected}
                  searchQuery={searchQuery}
                  colorMode={colorMode}
                  onSelect={setSelected}
                  onEnter={handleEnter}
                  onDelete={handleDelete}
                  onColorModeChange={setColorMode}
                />
              </section>
            )}

            {tree && viewMode === "files" && (
              <section className={`u-h-full ${SURFACE}`}>
                <TreeList
                  tree={tree}
                  rootId={0}
                  version={version}
                  expanded={expanded}
                  toggle={handleToggle}
                  selected={selected}
                  searchQuery={searchQuery}
                  onSelect={setSelected}
                  onEnter={handleEnter}
                  onDelete={handleDelete}
                  maxChildren={2000}
                />
              </section>
            )}

            {tree && viewMode === "largest" && (
              <section className={`u-h-full ${SURFACE}`}>
                <TopFilesView tree={tree} version={version} onSelect={setSelected} onEnter={handleEnter} onDelete={handleDelete} />
              </section>
            )}

            {tree && viewMode === "types" && (
              <section className={`u-h-full ${SURFACE}`}>
                <ExtensionView
                  tree={tree}
                  version={version}
                  onFilterExt={(ext) => {
                    setSearchQuery(`.${ext}`);
                    setViewMode("overview");
                  }}
                />
              </section>
            )}

            {viewMode === "performance" && (
              <section className={`u-h-full ${SURFACE}`}>
                <BenchmarkView />
              </section>
            )}
          </div>

          {/* 状态栏 */}
          <footer className="statusbar">
            <div className="status-left">
              {scanning ? (
                <Activity className="i14 u-shrink-0 pulse u-accent" />
              ) : status === "failed" ? (
                <AlertTriangle className="i14 u-shrink-0 u-danger" />
              ) : (
                <Check className="i14 u-shrink-0 u-success" />
              )}
              <span className="u-shrink-0">{statusText}</span>
              {scanning && scan.native && scan.currentPath && (
                <span className="status-path" title={scan.currentPath}>
                  · {scan.currentPath}
                </span>
              )}
              {!scanning && scan.engineUsed && (
                <span className="status-engine">· {ENGINE_LABELS[scan.engineUsed] ?? scan.engineUsed}</span>
              )}
              {stats.freedBytes > 0 && (
                <span className="status-freed">
                  {scan.native ? "已移到回收站" : "模拟释放"} {formatBytes(stats.freedBytes)}
                </span>
              )}
            </div>
            <div className="status-right">
              <span className="status-metric">{formatCount(stats.nodeCount)} 个节点</span>
              <span className="status-metric">前端内存 {memoryMB.toFixed(1)} MB</span>
              <span className="status-backend"><span className="dot-6 is-ok" />{scan.native ? "Rust 后端" : "浏览器演示"}</span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function EmptyState({
  native,
  scanning,
  progress,
  currentPath,
  canScan,
  onScan,
}: {
  native: boolean;
  scanning: boolean;
  progress: number;
  currentPath: string;
  canScan: boolean;
  onScan: () => void;
}) {
  return (
    <div className={`empty-state ${SURFACE}`}>
      <div className="empty-inner">
        <div className="empty-mark">
          {scanning ? <Activity className="i24 pulse" /> : <HardDrive className="i24" />}
        </div>
        {scanning ? (
          <>
            <h2 className="empty-title">正在扫描…</h2>
            <div className="meter meter-6">
              <div className="meter-fill meter-fill--fast" style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </div>
            <p className="empty-path u-truncate" title={currentPath}>
              {currentPath || "准备中"}
            </p>
          </>
        ) : (
          <>
            <h2 className="empty-title">选择磁盘开始分析</h2>
            <p className="empty-desc">
              {native
                ? "扫描整个 NTFS 卷时，以管理员身份运行可启用 MFT 直读（通常数秒完成），否则自动使用多线程并行遍历。"
                : "当前在浏览器中运行，使用模拟数据。"}
            </p>
            <button onClick={onScan} disabled={!canScan} className="btn-primary">
              <Play className="i14 i-fill-current" />
              扫描磁盘
            </button>
          </>
        )}
      </div>
    </div>
  );
}
