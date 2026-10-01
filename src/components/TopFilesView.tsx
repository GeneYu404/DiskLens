import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, File, Search, Trash2 } from "lucide-react";
import { FlatFileSummary, FlatTree, getCategory } from "../lib/tree";
import { formatBytes } from "../lib/format";

interface Props {
  tree: FlatTree;
  version: number;
  onSelect: (id: number) => void;
  onEnter: (id: number) => void;
  onDelete?: (id: number) => void;
}

export default function TopFilesView({ tree, version, onSelect, onEnter, onDelete }: Props) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(100);
  const [copied, setCopied] = useState<number | null>(null);

  const files = useMemo(() => tree.getTopLargestFiles(limit), [tree, version, limit]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => file.name.toLowerCase().includes(q) || file.path.toLowerCase().includes(q) || file.ext.toLowerCase().includes(q));
  }, [files, query]);

  const copyPath = async (file: FlatFileSummary) => {
    await navigator.clipboard?.writeText(file.path);
    setCopied(file.id);
    window.setTimeout(() => setCopied(null), 1100);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-fg">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stroke px-5 py-3">
        <div>
          <h2 className="text-[14px] font-semibold">占用空间最大的文件</h2>
          <p className="mt-0.5 text-[11px] text-fg2">快速定位镜像、媒体文件、虚拟机和大型缓存</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="relative flex h-8 items-center rounded-md border border-stroke-strong bg-card focus-within:border-accent">
            <Search className="ml-2.5 h-3.5 w-3.5 text-fg2" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选文件" className="w-44 bg-transparent px-2 text-[12px] outline-none placeholder:text-fg3" />
          </label>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="h-8 rounded-md border border-stroke-strong bg-card px-2 text-[12px] outline-none focus:border-accent">
            <option value={50}>前 50 项</option><option value={100}>前 100 项</option><option value={200}>前 200 项</option>
          </select>
        </div>
      </div>

      <div className="grid h-9 shrink-0 grid-cols-[44px_minmax(160px,1.2fr)_minmax(180px,2fr)_105px_105px_82px] items-center border-b border-stroke bg-layer-solid px-4 text-[11px] font-medium text-fg2">
        <span>#</span><span>文件名</span><span>位置</span><span className="text-right">大小</span><span className="text-right">修改日期</span><span className="text-center">操作</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.map((file, index) => {
          const category = getCategory(file.ext);
          const parent = tree.parent[file.id];
          return (
            <div key={file.id} onClick={() => onSelect(file.id)} className="group grid min-h-10 grid-cols-[44px_minmax(160px,1.2fr)_minmax(180px,2fr)_105px_105px_82px] items-center border-b border-stroke px-4 text-[12px] hover:bg-subtle">
              <span className="font-mono text-fg3">{String(index + 1).padStart(2, "0")}</span>
              <span className="flex min-w-0 items-center gap-2 pr-3">
                <File className="h-4 w-4 shrink-0" style={{ color: category.color }} />
                <span className="truncate font-medium" title={file.name}>{file.name}</span>
              </span>
              <span className="truncate pr-3 font-mono text-[11px] text-fg2" title={file.path}>{file.path}</span>
              <span className="text-right font-semibold tabular-nums text-accent">{formatBytes(file.size)}</span>
              <span className="text-right tabular-nums text-fg2">{new Date(file.modTime).toLocaleDateString()}</span>
              <span className="flex justify-center gap-0.5 opacity-50 group-hover:opacity-100">
                <button onClick={(e) => { e.stopPropagation(); if (parent >= 0) onEnter(parent); }} className="rounded p-1 text-fg2 hover:bg-subtle" title="定位文件夹"><ExternalLink className="h-3.5 w-3.5" /></button>
                <button onClick={(e) => { e.stopPropagation(); void copyPath(file); }} className="rounded p-1 text-fg2 hover:bg-subtle" title="复制路径">{copied === file.id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}</button>
                {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete(file.id); }} className="rounded p-1 text-danger hover:bg-danger-soft" title="模拟释放空间"><Trash2 className="h-3.5 w-3.5" /></button>}
              </span>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="p-10 text-center text-[13px] text-fg2">没有找到匹配的文件</div>}
      </div>
      <div className="flex h-7 shrink-0 items-center border-t border-stroke px-4 text-[10px] text-fg2">显示 {filtered.length} 个结果 · 排序方式：文件大小</div>
    </div>
  );
}