import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { FileCategory, FlatTree } from "../lib/tree";
import { formatBytes, formatCount } from "../lib/format";

interface Props { tree: FlatTree; version: number; onFilterExt?: (ext: string) => void; }

export default function ExtensionView({ tree, version, onFilterExt }: Props) {
  const [activeCategory, setActiveCategory] = useState("all");
  const [query, setQuery] = useState("");
  const extensions = useMemo(() => tree.getExtSummaryList(), [tree, version]);
  const total = useMemo(() => extensions.reduce((sum, item) => sum + item.size, 0), [extensions]);

  const categories = useMemo(() => {
    const summary = new Map<FileCategory, { label: string; color: string; size: number; count: number }>();
    for (const item of extensions) {
      const current = summary.get(item.cat) ?? { label: item.categoryLabel, color: item.color, size: 0, count: 0 };
      current.size += item.size;
      current.count += item.count;
      summary.set(item.cat, current);
    }
    return [...summary.entries()].sort((a, b) => b[1].size - a[1].size);
  }, [extensions]);

  const filtered = extensions.filter((item) =>
    (activeCategory === "all" || item.cat === activeCategory) && item.ext.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-fg">
      <div className="border-b border-stroke px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[14px] font-semibold">文件类型分布</h2>
            <p className="mt-0.5 text-[11px] text-fg2">按扩展名汇总空间占用与文件数量</p>
          </div>
          <div className="text-right"><div className="text-[10px] text-fg2">已分类空间</div><div className="mt-0.5 text-[14px] font-semibold text-accent">{formatBytes(total)}</div></div>
        </div>
        <div className="mt-4 flex h-3 overflow-hidden rounded-sm bg-app">
          {categories.map(([key, item]) => <div key={key} title={`${item.label} · ${formatBytes(item.size)}`} style={{ width: `${item.size / Math.max(1, total) * 100}%`, background: item.color }} />)}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button onClick={() => setActiveCategory("all")} className={`rounded px-2.5 py-1 text-[11px] ${activeCategory === "all" ? "bg-accent-soft font-semibold text-accent" : "text-fg2 hover:bg-subtle"}`}>全部类型</button>
          {categories.map(([key, item]) => <button key={key} onClick={() => setActiveCategory(key)} className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] ${activeCategory === key ? "bg-accent-soft font-semibold text-accent" : "text-fg2 hover:bg-subtle"}`}><span className="h-2 w-2 rounded-full" style={{ background: item.color }} />{item.label}</button>)}
        </div>
      </div>

      <div className="flex h-10 shrink-0 items-center justify-between border-b border-stroke px-5">
        <span className="text-[11px] text-fg2">{filtered.length} 种扩展名</span>
        <label className="flex h-7 items-center gap-2 rounded border border-stroke-strong px-2 focus-within:border-accent"><Search className="h-3.5 w-3.5 text-fg2" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选扩展名" className="w-36 text-[11px] outline-none placeholder:text-fg3" /></label>
      </div>

      <div className="grid h-8 shrink-0 grid-cols-[90px_minmax(120px,1fr)_120px_90px_100px_110px] items-center border-b border-stroke bg-layer-solid px-5 text-[11px] text-fg2">
        <span>扩展名</span><span>类别</span><span className="text-right">占用</span><span className="text-right">占比</span><span className="text-right">文件数</span><span className="text-right">操作</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.map((item) => {
          const pct = item.size / Math.max(1, total) * 100;
          return <div key={item.ext} className="grid min-h-10 grid-cols-[90px_minmax(120px,1fr)_120px_90px_100px_110px] items-center border-b border-stroke px-5 text-[12px] hover:bg-subtle">
            <span className="flex items-center gap-2 font-semibold"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} />.{item.ext}</span>
            <span className="text-fg2">{item.categoryLabel}</span>
            <span className="text-right font-semibold tabular-nums">{formatBytes(item.size)}</span>
            <span className="text-right tabular-nums text-fg2">{pct.toFixed(1)}%</span>
            <span className="text-right tabular-nums text-fg2">{formatCount(item.count)}</span>
            <span className="text-right">{onFilterExt && <button onClick={() => onFilterExt(item.ext)} className="rounded px-2 py-1 text-[11px] text-accent hover:bg-accent-soft">在地图中查找</button>}</span>
          </div>;
        })}
      </div>
    </div>
  );
}