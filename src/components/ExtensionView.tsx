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
    <div className="list-panel">
      <div className="ext-head">
        <div className="ext-head-row">
          <div>
            <h2 className="view-title">文件类型分布</h2>
            <p className="view-sub">按扩展名汇总空间占用与文件数量</p>
          </div>
          <div className="u-text-right"><div className="ext-total-label">已分类空间</div><div className="ext-total">{formatBytes(total)}</div></div>
        </div>
        <div className="ext-bar">
          {categories.map(([key, item]) => <div key={key} title={`${item.label} · ${formatBytes(item.size)}`} style={{ width: `${item.size / Math.max(1, total) * 100}%`, background: item.color }} />)}
        </div>
        <div className="ext-chips">
          <button onClick={() => setActiveCategory("all")} className={`chip ${activeCategory === "all" ? "chip--on" : "chip--off"}`}>全部类型</button>
          {categories.map(([key, item]) => <button key={key} onClick={() => setActiveCategory(key)} className={`ext-chip-row chip ${activeCategory === key ? "chip--on" : "chip--off"}`}><span className="chip-dot" style={{ background: item.color }} />{item.label}</button>)}
        </div>
      </div>

      <div className="ext-filter-row">
        <span className="ext-count">{filtered.length} 种扩展名</span>
        <label className="ext-filter"><Search className="i14 u-fg2" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选扩展名" className="ext-filter-input" /></label>
      </div>

      <div className="col-head col-head--sm col-head--pad5 ext-cols">
        <span>扩展名</span><span>类别</span><span className="col-right">占用</span><span className="col-right">占比</span><span className="col-right">文件数</span><span className="col-right">操作</span>
      </div>
      <div className="list-scroll">
        {filtered.map((item) => {
          const pct = item.size / Math.max(1, total) * 100;
          return <div key={item.ext} className="data-row data-row--pad5 ext-cols">
            <span className="ext-ext"><span className="ext-swatch" style={{ background: item.color }} />.{item.ext}</span>
            <span className="u-fg2">{item.categoryLabel}</span>
            <span className="data-size-plain">{formatBytes(item.size)}</span>
            <span className="data-num">{pct.toFixed(1)}%</span>
            <span className="data-num">{formatCount(item.count)}</span>
            <span className="col-right">{onFilterExt && <button onClick={() => onFilterExt(item.ext)} className="icon-btn--accent">在地图中查找</button>}</span>
          </div>;
        })}
      </div>
    </div>
  );
}