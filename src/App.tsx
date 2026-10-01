import { useEffect, useState } from "react";
import { formatBytes, formatCount, formatMs } from "./lib/format";
import { useDiskScan, type DriveOption, type EngineChoice } from "./lib/useDiskScan";
import TreeList from "./components/TreeList";
import Treemap, { type TreemapColorMode } from "./components/Treemap";
import TopFilesView from "./components/TopFilesView";
import ExtensionView from "./components/ExtensionView";
import BenchmarkView from "./components/BenchmarkView";
import PlanPanel from "./components/PlanPanel";
import RustCodeViewer from "./components/RustCodeViewer";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Database,
  FileCode2,
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

const SURFACE = "min-h-0 overflow-hidden rounded-[10px] border border-stroke bg-card shadow-panel";

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
  const [showPlan, setShowPlan] = useState(false);
  const [showRustCode, setShowRustCode] = useState(false);
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
        setShowPlan(false);
        setShowRustCode(false);
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
    <div className="fluent-shell flex h-screen min-h-[540px] flex-col overflow-hidden bg-app text-fg">
      {/* Tauri uses the system title bar. This is the app's own command header. */}
      <div className="flex h-[54px] shrink-0 items-center border-b border-stroke bg-acrylic px-5 backdrop-blur-xl max-sm:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-on-accent shadow-sm">
            <HardDrive className="h-[17px] w-[17px]" strokeWidth={1.9} />
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-[14px] font-semibold tracking-[-0.03em]">DiskLens</span>
            <span className="hidden text-[11px] text-fg3 sm:block">空间分析器</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-fg2" title={scan.native ? "Rust 后端正在处理本机磁盘" : "浏览器中使用模拟数据"}>
            <span className={`h-[6px] w-[6px] rounded-full ${scan.native ? "bg-success" : "bg-warning"}`} />
            {scan.native ? "已连接本机" : "演示模式"}
          </span>
          <span className="h-4 w-px bg-stroke" />
          <button onClick={() => setShowPlan(true)} className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-fg2 transition-colors hover:bg-subtle hover:text-fg" title="了解技术方案">
            <CircleHelp className="h-[15px] w-[15px]" strokeWidth={1.8} />
            <span className="hidden sm:inline">帮助</span>
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 导航栏 */}
        <aside className="fluent-sidebar flex w-[216px] shrink-0 flex-col border-r border-stroke bg-layer px-3 py-5 max-md:w-[62px] max-md:px-2">
          <div className="mb-3 px-3 text-[10px] font-semibold tracking-[0.08em] text-fg3 max-md:hidden">浏览</div>
          <nav className="space-y-1" aria-label="主导航">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const active = id === viewMode;
              return (
                <button
                  key={id}
                  onClick={() => setViewMode(id)}
                  title={label}
                  className={`fluent-nav-item relative flex h-[39px] w-full items-center gap-3 rounded-[7px] px-3 text-left text-[12px] max-md:justify-center max-md:px-0 ${
                    active ? "bg-card font-semibold text-accent shadow-sm" : "text-fg hover:bg-subtle"
                  }`}
                >
                  {active && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-accent" />}
                  <Icon className={`h-[17px] w-[17px] shrink-0 ${active ? "text-accent" : "text-fg2"}`} strokeWidth={1.8} />
                  <span className="max-md:hidden">{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="mx-3 my-5 border-t border-stroke max-md:mx-1" />
          <div className="mb-2 px-3 text-[10px] font-semibold tracking-[0.08em] text-fg3 max-md:hidden">磁盘</div>
          <div className="space-y-1">
            {drives.map((drive, index) => (
              <button
                key={drive.drive}
                onClick={() => handleDriveChange(index)}
                disabled={scanning}
                title={`${drive.drive} · ${drive.label}`}
                className={`flex w-full items-start gap-2.5 rounded-[7px] px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 max-md:justify-center max-md:px-1 ${index === driveIdx ? "bg-accent-soft text-accent" : "text-fg hover:bg-subtle"}`}
              >
                <HardDrive className={`mt-0.5 h-[16px] w-[16px] shrink-0 ${index === driveIdx ? "text-accent" : "text-fg2"}`} strokeWidth={1.8} />
                <div className="min-w-0 flex-1 max-md:hidden">
                  <div className="flex items-baseline justify-between gap-1 text-[11px]">
                    <span className="font-semibold">{drive.drive}</span>
                    <span className="shrink-0 text-[10px] font-normal text-fg3">{formatBytes(drive.totalCap)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-fg2">{drive.label}</div>
                  {drive.usedBytes > 0 && (
                    <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-stroke-strong">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, drive.usedBytes / drive.totalCap * 100)}%` }} />
                    </div>
                  )}
                </div>
              </button>
            ))}
            {drives.length === 0 && <p className="px-3 text-[11px] text-fg3 max-md:hidden">正在检测磁盘...</p>}
          </div>

          <div className="mt-auto space-y-1 border-t border-stroke pt-3">
            <button
              onClick={() => setShowPlan(true)}
              className="flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[12px] text-fg2 hover:bg-subtle max-md:justify-center max-md:px-0"
            >
              <CircleHelp className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              <span className="max-md:hidden">技术方案</span>
            </button>
            <button
              onClick={() => setShowRustCode(true)}
              className="flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[12px] text-fg2 hover:bg-subtle max-md:justify-center max-md:px-0"
            >
              <FileCode2 className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              <span className="max-md:hidden">Rust 后端源码</span>
            </button>
          </div>
        </aside>

        {/* 主内容 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="shrink-0 px-8 pb-4 pt-7 max-sm:px-4 max-sm:pt-4">
            <div className="mb-3 flex items-center gap-1.5 text-[11px] text-fg3">
              <span>此电脑</span><ChevronRight className="h-3 w-3" />
              <span>{activeDrive.drive}</span><ChevronRight className="h-3 w-3" />
              <span className="font-medium text-fg2">{VIEW_TITLES[viewMode]}</span>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h1 className="text-[27px] font-semibold tracking-[-0.035em] text-fg">{VIEW_TITLES[viewMode]}</h1>
                  {scan.native && <ShieldCheck className="h-[17px] w-[17px] text-success" aria-label="本机扫描" />}
                </div>
                <p className="mt-1 truncate text-[12px] text-fg2">{activeDrive.label} <span className="px-1 text-fg3">/</span> {activeDrive.fsType} <span className="px-1 text-fg3">/</span> {formatBytes(activeDrive.totalCap)}</p>
              </div>
              {scanning ? (
                <button onClick={scan.cancel} className="flex h-9 items-center gap-2 rounded-md border border-stroke-strong bg-card px-3.5 text-[12px] font-medium text-fg shadow-sm transition hover:bg-card-hover">
                  <Square className="h-3 w-3 fill-danger text-danger" /> 停止扫描
                </button>
              ) : (
                <button onClick={() => startScan()} disabled={drives.length === 0} className="flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-[12px] font-semibold text-on-accent shadow-sm transition hover:bg-accent-hover active:scale-[.98] disabled:bg-stroke-strong">
                  {status === "done" ? <RefreshCw className="h-[14px] w-[14px]" /> : <Play className="h-[14px] w-[14px] fill-current" />}
                  {status === "done" ? "重新扫描" : "开始扫描"}
                </button>
              )}
            </div>
          </header>

          {/* Explorer-like command bar */}
          <div className="mx-8 flex min-h-[52px] shrink-0 flex-wrap items-center gap-2 border-y border-stroke py-2 max-sm:mx-4">
            <label className="relative flex h-8 min-w-[180px] max-w-[310px] flex-1 items-center rounded-md border border-stroke-strong bg-card shadow-sm transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft">
              <Search className="ml-2.5 h-4 w-4 shrink-0 text-fg3" strokeWidth={1.8} />
              <input id="disklens-search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索文件或文件夹" className="min-w-0 flex-1 bg-transparent px-2 text-[12px] text-fg outline-none placeholder:text-fg3" />
              {searchQuery ? <button onClick={() => setSearchQuery("")} className="mr-2 text-fg3 hover:text-fg" aria-label="清除搜索"><X className="h-3.5 w-3.5" /></button> : <kbd className="mr-2 hidden rounded border border-stroke px-1.5 py-0.5 text-[10px] text-fg3 lg:block">Ctrl K</kbd>}
            </label>
            <div className="relative">
              <button onClick={() => setShowScanOptions((v) => !v)} aria-expanded={showScanOptions} className={`flex h-8 items-center gap-2 rounded-md px-2.5 text-[12px] transition-colors ${showScanOptions ? "bg-accent-soft text-accent" : "text-fg2 hover:bg-subtle"}`}>
                <Settings2 className="h-[15px] w-[15px]" strokeWidth={1.8} /> 扫描选项 <ChevronDown className="h-3 w-3" />
              </button>
              {showScanOptions && <div className="absolute left-0 top-10 z-30 w-[265px] rounded-[9px] border border-stroke bg-card p-4 shadow-flyout">
                <div className="text-[12px] font-semibold text-fg">扫描设置</div>
                <p className="mt-1 text-[11px] leading-relaxed text-fg2">更改设置后，在下次扫描时生效。</p>
                <label className="mt-4 block text-[11px] font-medium text-fg2">扫描引擎</label>
                <select value={engine} onChange={(e) => setEngine(e.target.value as EngineChoice)} disabled={scanning} className="mt-1.5 h-8 w-full rounded-md border border-stroke-strong bg-card px-2 text-[12px] outline-none focus:border-accent disabled:opacity-50"><option value="mft">自动（优先 NTFS MFT）</option><option value="rayon">并行目录遍历</option></select>
                <label className="mt-3 block text-[11px] font-medium text-fg2">工作线程</label>
                <select value={threads} onChange={(e) => setThreads(Number(e.target.value))} disabled={scanning} className="mt-1.5 h-8 w-full rounded-md border border-stroke-strong bg-card px-2 text-[12px] outline-none focus:border-accent disabled:opacity-50">{[4, 8, 12, 16, 32].map((n) => <option key={n} value={n}>{n} 线程</option>)}</select>
                <div className="mt-3 flex gap-2 border-t border-stroke pt-3 text-[10px] leading-relaxed text-fg2"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> MFT 仅适用于 NTFS 整卷，可能需要管理员权限。</div>
              </div>}
            </div>
            <div className="mx-1 h-4 w-px bg-stroke max-sm:hidden" />
            <span className="hidden text-[11px] text-fg3 sm:inline">{scan.native ? "真实磁盘" : "演示数据"}</span>
            {scanning && <span className="ml-auto flex items-center gap-2 text-[11px] font-medium text-accent"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />正在分析 {scan.progress > 0 ? `${(scan.progress * 100).toFixed(0)}%` : "..."}</span>}
            {!scanning && stats.files > 0 && <span className="ml-auto text-[11px] text-fg3">扫描于 {formatMs(scan.elapsed)} 内完成</span>}
          </div>

          {/* Compact capacity summary, not a dashboard of competing cards */}
          <section className="mx-8 flex shrink-0 flex-wrap items-center gap-x-9 gap-y-3 py-4 max-sm:mx-4">
            <div className="flex min-w-[240px] flex-[2] items-center gap-3.5">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[9px] bg-accent-soft text-accent"><HardDrive className="h-[19px] w-[19px]" strokeWidth={1.7} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2"><span className="text-[15px] font-semibold tracking-[-.02em] text-fg">{formatBytes(stats.bytes)}</span><span className="text-[11px] text-fg2">已分析 / {formatBytes(activeDrive.totalCap)}</span></div>
                <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-stroke-strong"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(scanning || stats.bytes > 0 ? 1 : 0, capacityPct)}%` }} /></div>
                {scan.native && activeDrive.usedBytes > 0 && <span className="mt-1 block text-[10px] text-fg3">磁盘实际已用 {diskUsedPct.toFixed(0)}%</span>}
              </div>
            </div>
            <Metric label="文件" value={formatCount(stats.files)} />
            <Metric label="文件夹" value={formatCount(stats.dirs)} />
            <Metric label="扫描用时" value={formatMs(scan.elapsed)} />
            <Metric label="处理速度" value={`${formatCount(throughput)}/秒`} />
          </section>

          {scan.message && (
            <div className="mx-7 mt-3 flex items-start gap-2 rounded-md border border-warning-soft bg-warning-soft px-3 py-2 text-[12px] text-warning max-sm:mx-4">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span className="flex-1">{scan.message}</span>
            </div>
          )}

          {/* 工作区 */}
          <div className="min-h-0 flex-1 px-8 pb-5 pt-1 max-sm:px-4">
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
              <div className="grid h-full min-h-0 grid-cols-1 grid-rows-2 gap-3 lg:grid-cols-[minmax(360px,40%)_minmax(0,1fr)] lg:grid-rows-1">
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
              <section className={`h-full ${SURFACE}`}>
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
              <section className={`h-full ${SURFACE}`}>
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
              <section className={`h-full ${SURFACE}`}>
                <TopFilesView tree={tree} version={version} onSelect={setSelected} onEnter={handleEnter} onDelete={handleDelete} />
              </section>
            )}

            {tree && viewMode === "types" && (
              <section className={`h-full ${SURFACE}`}>
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
              <section className={`h-full ${SURFACE}`}>
                <BenchmarkView />
              </section>
            )}
          </div>

          {/* 状态栏 */}
          <footer className="flex h-9 shrink-0 items-center justify-between gap-4 border-t border-stroke bg-acrylic px-8 text-[11px] text-fg2 max-sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              {scanning ? (
                <Activity className="h-3.5 w-3.5 shrink-0 animate-pulse text-accent" />
              ) : status === "failed" ? (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
              ) : (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              )}
              <span className="shrink-0">{statusText}</span>
              {scanning && scan.native && scan.currentPath && (
                <span className="truncate text-fg3" title={scan.currentPath}>
                  · {scan.currentPath}
                </span>
              )}
              {!scanning && scan.engineUsed && (
                <span className="hidden shrink-0 text-fg3 sm:inline">· {ENGINE_LABELS[scan.engineUsed] ?? scan.engineUsed}</span>
              )}
              {stats.freedBytes > 0 && (
                <span className="ml-2 shrink-0 text-danger">
                  {scan.native ? "已移到回收站" : "模拟释放"} {formatBytes(stats.freedBytes)}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <span className="hidden sm:inline">{formatCount(stats.nodeCount)} 个节点</span>
              <span className="hidden sm:inline">前端内存 {memoryMB.toFixed(1)} MB</span>
              <span className="hidden items-center gap-1 lg:flex"><span className="h-1.5 w-1.5 rounded-full bg-success" />{scan.native ? "Rust 后端" : "浏览器演示"}</span>
            </div>
          </footer>
        </main>
      </div>

      {showPlan && <PlanPanel onClose={() => setShowPlan(false)} onOpenCodeViewer={() => setShowRustCode(true)} />}
      {showRustCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm" onClick={() => setShowRustCode(false)}>
          <div
            className="flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-stroke bg-card shadow-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-stroke px-5">
              <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
                <Code2 className="h-4 w-4 text-accent" /> Rust 后端源码
              </div>
              <button onClick={() => setShowRustCode(false)} className="rounded p-1.5 text-fg2 hover:bg-subtle" aria-label="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <RustCodeViewer />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[77px] border-l border-stroke pl-5 leading-tight max-sm:min-w-[64px] max-sm:pl-3">
      <div className="text-[10px] text-fg3">{label}</div>
      <div className="mt-1.5 text-[14px] font-semibold tabular-nums tracking-[-.02em] text-fg">{value}</div>
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
    <div className={`grid h-full place-items-center ${SURFACE}`}>
      <div className="max-w-md px-6 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-accent-soft text-accent">
          {scanning ? <Activity className="h-6 w-6 animate-pulse" /> : <HardDrive className="h-6 w-6" />}
        </div>
        {scanning ? (
          <>
            <h2 className="mt-4 text-[15px] font-semibold">正在扫描…</h2>
            <div className="mx-auto mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-stroke-strong">
              <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </div>
            <p className="mt-3 truncate text-[11px] text-fg3" title={currentPath}>
              {currentPath || "准备中"}
            </p>
          </>
        ) : (
          <>
            <h2 className="mt-4 text-[15px] font-semibold">选择磁盘开始分析</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-fg2">
              {native
                ? "扫描整个 NTFS 卷时，以管理员身份运行可启用 MFT 直读（通常数秒完成），否则自动使用多线程并行遍历。"
                : "当前在浏览器中运行，使用模拟数据。"}
            </p>
            <button
              onClick={onScan}
              disabled={!canScan}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-[12px] font-semibold text-on-accent hover:bg-accent-hover disabled:bg-stroke-strong"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              扫描磁盘
            </button>
          </>
        )}
      </div>
    </div>
  );
}
