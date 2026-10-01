import { useState } from "react";
import { Code2, Cpu, HardDrive, Layers, ShieldCheck, X } from "lucide-react";

interface Props { onClose: () => void; onOpenCodeViewer?: () => void; }
type Tab = "overview" | "mft" | "memory" | "stack";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "性能路线" },
  { id: "mft", label: "NTFS 元数据" },
  { id: "memory", label: "内存布局" },
  { id: "stack", label: "技术栈" },
];

export default function PlanPanel({ onClose, onOpenCodeViewer }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-5 backdrop-blur-sm" onClick={onClose}>
      <section className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-stroke bg-card text-fg shadow-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-stroke bg-card px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent"><HardDrive className="h-[18px] w-[18px]" /></span>
            <div><h2 className="text-[15px] font-semibold">高性能磁盘占用查看器</h2><p className="mt-0.5 text-[11px] text-fg2">扫描 · 紧凑数据结构 · 视口渲染</p></div>
          </div>
          <div className="flex items-center gap-2">
            {onOpenCodeViewer && <button onClick={() => { onClose(); onOpenCodeViewer(); }} className="flex h-8 items-center gap-1.5 rounded-md border border-stroke bg-card px-2.5 text-[11px] font-medium hover:bg-subtle"><Code2 className="h-3.5 w-3.5 text-accent" />Rust 示例</button>}
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md text-fg2 hover:bg-subtle" aria-label="关闭"><X className="h-4 w-4" /></button>
          </div>
        </header>

        <nav className="flex shrink-0 gap-1 border-b border-stroke bg-card px-5" aria-label="方案章节">
          {TABS.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`relative px-3 py-3 text-[12px] ${tab === item.id ? "font-semibold text-accent" : "text-fg2 hover:text-fg"}`}>{item.label}{tab === item.id && <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded bg-accent" />}</button>)}
        </nav>

        <div className="min-h-0 flex-1 overflow-auto p-6">
          {tab === "overview" && <Performance />}
          {tab === "mft" && <Mft />}
          {tab === "memory" && <Memory />}
          {tab === "stack" && <Stack />}
        </div>
      </section>
    </div>
  );
}

function Performance() {
  const rows = [
    ["Python os.walk + stat", "30–120 秒", "每个文件额外 stat，单线程"],
    ["Python os.scandir", "15–60 秒", "复用目录项属性，仍有解释器开销"],
    ["C++ / Rust 单线程", "5–20 秒", "原生遍历，受单核与寻址影响"],
    ["Rust Rayon 多线程", "2–8 秒", "通用路线；工作窃取并行扫描"],
    ["NTFS $MFT 直读", "1–3 秒", "顺序读取元数据；需要管理员权限"],
    ["USN Journal 增量", "毫秒级", "首次建立索引后仅同步变更"],
  ];
  return <div className="space-y-5">
    <div><h3 className="text-[14px] font-semibold">百万文件扫描的典型量级</h3><p className="mt-1 text-[12px] text-fg2">参考方案中的估算值；实际结果受磁盘、文件系统和目录分布影响。</p></div>
    <div className="overflow-hidden rounded-lg border border-stroke bg-card">
      <div className="grid grid-cols-[1.05fr_110px_1.5fr] border-b border-stroke bg-layer-solid px-4 py-2.5 text-[11px] font-semibold text-fg2"><span>方案</span><span>参考耗时</span><span>特点</span></div>
      {rows.map(([name, time, note], index) => <div key={name} className={`grid grid-cols-[1.05fr_110px_1.5fr] border-b border-stroke px-4 py-3 text-[12px] last:border-0 ${index === 3 || index === 4 ? "bg-accent-soft" : ""}`}><span className={index === 3 || index === 4 ? "font-semibold text-accent" : ""}>{name}</span><span className="font-medium tabular-nums">{time}</span><span className="text-fg2">{note}</span></div>)}
    </div>
    <div className="flex gap-3 rounded-lg border border-accent-soft bg-accent-soft p-4"><Cpu className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><p className="text-[12px] leading-relaxed text-fg">建议先实现 Rust 多线程遍历作为通用基线，再为 NTFS 增加 MFT 加速模式。USN Journal 本身不提供完整文件大小，适合用于首次扫描后的增量同步。</p></div>
  </div>;
}

function Mft() {
  const steps = ["以管理员权限访问 NTFS 卷", "从引导扇区定位 $MFT", "顺序批量读取 FILE 记录", "解析 $FILE_NAME 与 $DATA 属性", "按父记录号建立目录关系", "从叶节点向根目录汇总大小"];
  return <div className="space-y-5">
    <div><h3 className="text-[14px] font-semibold">NTFS 元数据读取</h3><p className="mt-1 text-[12px] text-fg2">直接读取 MFT 可减少逐目录打开带来的元数据寻址。</p></div>
    <div className="grid gap-2 sm:grid-cols-2">
      {steps.map((step, index) => <div key={step} className="flex items-center gap-3 rounded-lg border border-stroke bg-card p-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent-soft text-[12px] font-semibold text-accent">{index + 1}</span><span className="text-[12px]">{step}</span></div>)}
    </div>
    <div className="flex gap-3 rounded-lg border border-warning-soft bg-warning-soft p-4"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><p className="text-[12px] leading-relaxed text-fg">需要管理员权限且仅适用于 NTFS。生产实现还需正确处理硬链接、$ATTRIBUTE_LIST、稀疏文件、压缩文件和 MFT 更新期间的一致性。</p></div>
  </div>;
}

function Memory() {
  return <div className="space-y-5">
    <div><h3 className="text-[14px] font-semibold">用下标代替对象指针</h3><p className="mt-1 text-[12px] text-fg2">百万至千万级节点建议使用连续数组、字符串池和惰性排序。</p></div>
    <pre className="overflow-auto rounded-lg border border-stroke bg-app p-4 font-mono text-[12px] leading-6 text-fg">{`struct FlatNode {\n    size: u64,           // 子树总占用\n    parent: u32,         // 父节点下标\n    first_child: u32,    // 首个子节点\n    next_sibling: u32,   // 下一个兄弟节点\n    name_offset: u32,    // 共享字符串池偏移\n    name_len: u16,       // 名称字节长度\n    flags: u16,          // 目录与属性标记\n}`}</pre>
    <div className="grid gap-4 sm:grid-cols-2"><div className="flex gap-3"><Layers className="mt-0.5 h-4 w-4 text-accent" /><p className="text-[12px] leading-relaxed text-fg2">连续 TypedArray 减少堆分配与指针跳转，对 CPU 缓存更友好；子节点按需排序并缓存。</p></div><div className="flex gap-3"><HardDrive className="mt-0.5 h-4 w-4 text-accent" /><p className="text-[12px] leading-relaxed text-fg2">UI 只获取当前展开层的数据，列表使用虚拟滚动，树图使用 Canvas 批量绘制。</p></div></div>
  </div>;
}

function Stack() {
  const options = [
    ["Rust + Tauri", "推荐", "Rust 负责扫描与索引；前端以 Canvas 呈现矩形树图。"],
    ["Rust + egui", "轻量", "单进程即时模式 UI，集成简洁，原生绘制效率高。"],
    ["Rust + PySide6", "兼容", "通过 PyO3 暴露扫描核心，适合已有 Python 工具链。"],
  ];
  return <div className="space-y-5">
    <div><h3 className="text-[14px] font-semibold">按产品目标选择界面</h3><p className="mt-1 text-[12px] text-fg2">扫描核心与渲染层分离，后续可独立替换 MFT 和 USN 模块。</p></div>
    <div className="divide-y divide-stroke rounded-lg border border-stroke bg-card">
      {options.map(([title, label, description]) => <div key={title} className="flex items-start gap-4 p-4"><span className="mt-0.5 w-28 shrink-0 text-[13px] font-semibold">{title}</span><span className="rounded bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">{label}</span><p className="text-[12px] leading-relaxed text-fg2">{description}</p></div>)}
    </div>
    <ol className="space-y-2 pl-5 text-[12px] leading-relaxed text-fg2 marker:text-accent"><li>完成 Rust CLI 多线程遍历基线。</li><li>增加扫描进度、取消和 Top 文件列表。</li><li>切换 FlatTree 与虚拟列表，控制内存占用。</li><li>添加 NTFS MFT 与 USN 增量更新。</li></ol>
  </div>;
}