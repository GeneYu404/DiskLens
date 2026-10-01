import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, File, Folder, FolderOpen, Trash2 } from "lucide-react";
import { FlatTree, getCategory } from "../lib/tree";
import { extOf, formatBytes, formatCount } from "../lib/format";

const ROW_HEIGHT = 31;
const OVERSCAN = 8;
type SortKey = "size" | "name" | "count" | "age";

interface Props {
  tree: FlatTree;
  rootId: number;
  version: number;
  expanded: Set<number>;
  toggle: (id: number) => void;
  selected: number;
  searchQuery: string;
  onSelect: (id: number) => void;
  onEnter: (id: number) => void;
  onDelete?: (id: number) => void;
  maxChildren?: number;
}

interface Row { id: number; depth: number; isDir: boolean; hasChildren: boolean; }

export default function TreeList({
  tree, rootId, version, expanded, toggle, selected, searchQuery, onSelect, onEnter, onDelete, maxChildren = 500,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(500);
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [ascending, setAscending] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const compare = useCallback((a: number, b: number) => {
    let value = 0;
    if (sortKey === "name") value = tree.name(a).localeCompare(tree.name(b));
    if (sortKey === "size") value = tree.size[b] - tree.size[a];
    if (sortKey === "count") value = tree.fileCount[b] - tree.fileCount[a];
    if (sortKey === "age") value = (tree.modDaysAgo[a] || 0) - (tree.modDaysAgo[b] || 0);
    return ascending ? -value : value;
  }, [tree, sortKey, ascending]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    const query = searchQuery.trim().toLowerCase().replace(/^\*\./, ".");

    const walk = (id: number, depth: number) => {
      if (tree.isDeleted(id)) return;
      const isDir = tree.isDir(id);
      const children = isDir ? tree.children(id, true) : null;
      result.push({ id, depth, isDir, hasChildren: Boolean(children?.length) });
      if (!isDir || !expanded.has(id) || !children) return;

      let ordered = Array.from(children);
      if (sortKey !== "size" || ascending) ordered.sort(compare);
      let shown = 0;
      for (const child of ordered) {
        if (query && !tree.name(child).toLowerCase().includes(query) && !tree.isDir(child)) continue;
        walk(child, depth + 1);
        shown++;
        if (!query && shown >= maxChildren) break;
      }
    };
    walk(rootId, 0);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, rootId, expanded, version, searchQuery, sortKey, ascending, maxChildren]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const rootSize = Math.max(1, tree.size[rootId]);

  const sort = (key: SortKey) => {
    if (sortKey === key) setAscending((v) => !v);
    else { setSortKey(key); setAscending(key === "name"); }
  };

  const copyPath = async (id: number) => {
    await navigator.clipboard?.writeText(tree.fullPath(id));
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1100);
  };

  return (
    <div className="tree-list flex h-full min-h-0 flex-col bg-card text-fg">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-stroke px-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <FolderOpen className="h-4 w-4 text-warning" strokeWidth={1.8} />
          文件资源
        </div>
        <span className="text-[11px] text-fg3">{formatCount(rows.length)} 项</span>
      </div>

      <div className="tree-grid grid h-9 shrink-0 items-center border-b border-stroke bg-layer-solid px-3 text-[11px] font-medium text-fg2">
        <button onClick={() => sort("name")} className="text-left hover:text-accent">名称</button>
        <button onClick={() => sort("size")} className="text-right hover:text-accent">大小</button>
        <span className="text-right">占比</span>
        <button onClick={() => sort("count")} className="tree-count text-right hover:text-accent">文件数</button>
        <button onClick={() => sort("age")} className="tree-age text-right hover:text-accent">修改</button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
          {rows.slice(start, end).map((row, offset) => {
            const index = start + offset;
            const id = row.id;
            const name = tree.name(id);
            const pct = tree.size[id] / rootSize * 100;
            const selectedRow = selected === id;
            const expandedRow = expanded.has(id);
            const category = row.isDir ? null : getCategory(extOf(name));
            return (
              <div
                key={id}
                onClick={() => onSelect(id)}
                onDoubleClick={() => row.isDir && onEnter(id)}
                className={`tree-grid group absolute left-0 right-0 grid items-center border-b border-stroke pr-3 text-[12px] transition-colors ${selectedRow ? "bg-accent-soft text-accent" : "hover:bg-subtle"}`}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: 8 + row.depth * 14 }}>
                  <button
                    className="grid h-5 w-4 shrink-0 place-items-center text-fg2 hover:text-accent"
                    onClick={(event) => { event.stopPropagation(); if (row.isDir && row.hasChildren) toggle(id); }}
                    aria-label={expandedRow ? "折叠" : "展开"}
                  >
                    {row.hasChildren ? (expandedRow ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : null}
                  </button>
                  {row.isDir ? (
                    expandedRow ? <FolderOpen className="h-4 w-4 shrink-0 text-warning" strokeWidth={1.7} /> : <Folder className="h-4 w-4 shrink-0 text-warning" strokeWidth={1.7} />
                  ) : <File className="h-4 w-4 shrink-0" style={{ color: category?.color ?? "var(--text-2)" }} strokeWidth={1.7} />}
                  <span className={`truncate ${row.isDir ? "font-medium text-fg" : "text-fg"}`} title={name}>{name}</span>
                  <div className="ml-auto hidden shrink-0 items-center gap-0.5 bg-inherit opacity-0 group-hover:flex group-hover:opacity-100">
                    {row.isDir && <button onClick={(e) => { e.stopPropagation(); onEnter(id); }} className="rounded p-1 text-fg2 hover:bg-subtle" title="打开目录"><ExternalLink className="h-3.5 w-3.5" /></button>}
                    <button onClick={(e) => { e.stopPropagation(); void copyPath(id); }} className="rounded p-1 text-fg2 hover:bg-subtle" title="复制路径">{copiedId === id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}</button>
                    {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete(id); }} className="rounded p-1 text-danger hover:bg-danger-soft" title="模拟释放空间"><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                </div>
                <span className="text-right tabular-nums text-fg">{formatBytes(tree.size[id])}</span>
                <span className="text-right tabular-nums text-fg2">{pct < 0.1 ? "<0.1" : pct.toFixed(1)}%</span>
                <span className="tree-count text-right tabular-nums text-fg2">{row.isDir ? formatCount(tree.fileCount[id]) : "1"}</span>
                <span className="tree-age text-right tabular-nums text-fg2">{tree.modDaysAgo[id] || 0} 天</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex h-7 shrink-0 items-center justify-between border-t border-stroke px-3 text-[10px] text-fg2">
        <span>已展开 {formatCount(rows.length)} 项</span>
        <span>当前渲染 {end - start} 行</span>
      </div>
    </div>
  );
}