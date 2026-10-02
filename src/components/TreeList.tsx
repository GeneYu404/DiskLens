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
    <div className="tree-list list-panel">
      <div className="panel-head">
        <div className="panel-title">
          <FolderOpen className="panel-title-icon" strokeWidth={1.8} />
          文件资源
        </div>
        <span className="panel-note">{formatCount(rows.length)} 项</span>
      </div>

      <div className="tree-grid col-head tree-head">
        <button onClick={() => sort("name")} className="col-head-btn">名称</button>
        <button onClick={() => sort("size")} className="col-head-btn--right col-head-btn">大小</button>
        <span className="col-right">占比</span>
        <button onClick={() => sort("count")} className="tree-count col-head-btn--right col-head-btn">文件数</button>
        <button onClick={() => sort("age")} className="tree-age col-head-btn--right col-head-btn">修改</button>
      </div>

      <div ref={scrollRef} className="list-scroll" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="u-relative" style={{ height: rows.length * ROW_HEIGHT }}>
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
                className={`tree-grid t-colors tree-row ${selectedRow ? "tree-row--on" : ""}`}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                <div className="tree-cell" style={{ paddingLeft: 8 + row.depth * 14 }}>
                  <button
                    className="tree-toggle"
                    onClick={(event) => { event.stopPropagation(); if (row.isDir && row.hasChildren) toggle(id); }}
                    aria-label={expandedRow ? "折叠" : "展开"}
                  >
                    {row.hasChildren ? (expandedRow ? <ChevronDown className="i14" /> : <ChevronRight className="i14" />) : null}
                  </button>
                  {row.isDir ? (
                    expandedRow ? <FolderOpen className="tree-folder" strokeWidth={1.7} /> : <Folder className="tree-folder" strokeWidth={1.7} />
                  ) : <File className="tree-file" style={{ color: category?.color ?? "var(--text-2)" }} strokeWidth={1.7} />}
                  <span className={`tree-name ${row.isDir ? "tree-name--dir" : ""}`} title={name}>{name}</span>
                  <div className="tree-cell-actions">
                    {row.isDir && <button onClick={(e) => { e.stopPropagation(); onEnter(id); }} className="icon-btn" title="打开目录"><ExternalLink className="i14" /></button>}
                    <button onClick={(e) => { e.stopPropagation(); void copyPath(id); }} className="icon-btn" title="复制路径">{copiedId === id ? <Check className="i14 u-success" /> : <Copy className="i14" />}</button>
                    {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete(id); }} className="icon-btn--danger icon-btn" title="模拟释放空间"><Trash2 className="i14" /></button>}
                  </div>
                </div>
                <span className="tree-size">{formatBytes(tree.size[id])}</span>
                <span className="tree-pct">{pct < 0.1 ? "<0.1" : pct.toFixed(1)}%</span>
                <span className="tree-count tree-pct">{row.isDir ? formatCount(tree.fileCount[id]) : "1"}</span>
                <span className="tree-age tree-pct">{tree.modDaysAgo[id] || 0} 天</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel-foot panel-foot--spread">
        <span>已展开 {formatCount(rows.length)} 项</span>
        <span>当前渲染 {end - start} 行</span>
      </div>
    </div>
  );
}