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
    <div className="scrim" onClick={onClose}>
      <section className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <div className="dialog-title-row">
            <span className="dialog-mark"><HardDrive className="i18" /></span>
            <div><h2 className="dialog-title">高性能磁盘占用查看器</h2><p className="dialog-subtitle">扫描 · 紧凑数据结构 · 视口渲染</p></div>
          </div>
          <div className="dialog-actions">
            {onOpenCodeViewer && <button onClick={() => { onClose(); onOpenCodeViewer(); }} className="dialog-code-btn"><Code2 className="i14 u-accent" />Rust 示例</button>}
            <button onClick={onClose} className="dialog-close" aria-label="关闭"><X className="i16" /></button>
          </div>
        </header>

        <nav className="dialog-tabs" aria-label="方案章节">
          {TABS.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`dialog-tab ${tab === item.id ? "dialog-tab--on" : ""}`}>{item.label}{tab === item.id && <span className="dialog-tab-ink" />}</button>)}
        </nav>

        <div className="dialog-body">
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
  return <div className="stack-5">
    <div><h3 className="dialog-section-title">百万文件扫描的典型量级</h3><p className="dialog-section-note">参考方案中的估算值；实际结果受磁盘、文件系统和目录分布影响。</p></div>
    <div className="dialog-table">
      <div className="dialog-thead"><span>方案</span><span>参考耗时</span><span>特点</span></div>
      {rows.map(([name, time, note], index) => <div key={name} className={`dialog-trow ${index === 3 || index === 4 ? "dialog-trow--hl" : ""}`}><span className={index === 3 || index === 4 ? "dialog-tname" : ""}>{name}</span><span className="dialog-ttime">{time}</span><span className="dialog-tnote">{note}</span></div>)}
    </div>
    <div className="dialog-callout"><Cpu className="dialog-callout-icon" /><p className="dialog-callout-text">建议先实现 Rust 多线程遍历作为通用基线，再为 NTFS 增加 MFT 加速模式。USN Journal 本身不提供完整文件大小，适合用于首次扫描后的增量同步。</p></div>
  </div>;
}

function Mft() {
  const steps = ["以管理员权限访问 NTFS 卷", "从引导扇区定位 $MFT", "顺序批量读取 FILE 记录", "解析 $FILE_NAME 与 $DATA 属性", "按父记录号建立目录关系", "从叶节点向根目录汇总大小"];
  return <div className="stack-5">
    <div><h3 className="dialog-section-title">NTFS 元数据读取</h3><p className="dialog-section-note">直接读取 MFT 可减少逐目录打开带来的元数据寻址。</p></div>
    <div className="dialog-grid-2 dialog-grid-2--tight">
      {steps.map((step, index) => <div key={step} className="dialog-step"><span className="dialog-step-num">{index + 1}</span><span className="dialog-step-text">{step}</span></div>)}
    </div>
    <div className="dialog-callout--warn dialog-callout"><ShieldCheck className="dialog-callout-icon" /><p className="dialog-callout-text">需要管理员权限且仅适用于 NTFS。生产实现还需正确处理硬链接、$ATTRIBUTE_LIST、稀疏文件、压缩文件和 MFT 更新期间的一致性。</p></div>
  </div>;
}

function Memory() {
  return <div className="stack-5">
    <div><h3 className="dialog-section-title">用下标代替对象指针</h3><p className="dialog-section-note">百万至千万级节点建议使用连续数组、字符串池和惰性排序。</p></div>
    <pre className="dialog-code">{`struct FlatNode {
    size: u64,           // 子树总占用
    parent: u32,         // 父节点下标
    first_child: u32,    // 首个子节点
    next_sibling: u32,   // 下一个兄弟节点
    name_offset: u32,    // 共享字符串池偏移
    name_len: u16,       // 名称字节长度
    flags: u16,          // 目录与属性标记
}`}</pre>
    <div className="dialog-grid-2">
      <div className="insight"><Layers className="insight-icon i16" /><p className="dialog-note">连续 TypedArray 减少堆分配与指针跳转，对 CPU 缓存更友好；子节点按需排序并缓存。</p></div>
      <div className="insight"><HardDrive className="insight-icon i16" /><p className="dialog-note">UI 只获取当前展开层的数据，列表使用虚拟滚动，树图使用 Canvas 批量绘制。</p></div>
    </div>
  </div>;
}

function Stack() {
  const options = [
    ["Rust + Tauri", "推荐", "Rust 负责扫描与索引；前端以 Canvas 呈现矩形树图。"],
    ["Rust + egui", "轻量", "单进程即时模式 UI，集成简洁，原生绘制效率高。"],
    ["Rust + PySide6", "兼容", "通过 PyO3 暴露扫描核心，适合已有 Python 工具链。"],
  ];
  return <div className="stack-5">
    <div><h3 className="dialog-section-title">按产品目标选择界面</h3><p className="dialog-section-note">扫描核心与渲染层分离，后续可独立替换 MFT 和 USN 模块。</p></div>
    <div className="dialog-choices">
      {options.map(([title, label, description]) => <div key={title} className="choice"><span className="choice-title">{title}</span><span className="dialog-badge">{label}</span><p className="choice-desc">{description}</p></div>)}
    </div>
    <ol className="dialog-list stack-2"><li>完成 Rust CLI 多线程遍历基线。</li><li>增加扫描进度、取消和 Top 文件列表。</li><li>切换 FlatTree 与虚拟列表，控制内存占用。</li><li>添加 NTFS MFT 与 USN 增量更新。</li></ol>
  </div>;
}
