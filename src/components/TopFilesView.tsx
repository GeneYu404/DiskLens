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
    <div className="list-panel">
      <div className="view-head">
        <div>
          <h2 className="view-title">占用空间最大的文件</h2>
          <p className="view-sub">快速定位镜像、媒体文件、虚拟机和大型缓存</p>
        </div>
        <div className="view-tools">
          <label className="filter-field">
            <Search className="filter-icon" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选文件" className="filter-input" />
          </label>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="limit-select">
            <option value={50}>前 50 项</option><option value={100}>前 100 项</option><option value={200}>前 200 项</option>
          </select>
        </div>
      </div>

      <div className="col-head col-head--pad4 files-cols">
        <span>#</span><span>文件名</span><span>位置</span><span className="col-right">大小</span><span className="col-right">修改日期</span><span className="col-center">操作</span>
      </div>

      <div className="list-scroll">
        {filtered.map((file, index) => {
          const category = getCategory(file.ext);
          const parent = tree.parent[file.id];
          return (
            <div key={file.id} onClick={() => onSelect(file.id)} className="data-row data-row--pad4 files-cols">
              <span className="data-ordinal">{String(index + 1).padStart(2, "0")}</span>
              <span className="data-name">
                <File className="i16 u-shrink-0" style={{ color: category.color }} />
                <span className="data-name-text" title={file.name}>{file.name}</span>
              </span>
              <span className="data-path" title={file.path}>{file.path}</span>
              <span className="data-size">{formatBytes(file.size)}</span>
              <span className="data-date">{new Date(file.modTime).toLocaleDateString()}</span>
              <span className="row-actions">
                <button onClick={(e) => { e.stopPropagation(); if (parent >= 0) onEnter(parent); }} className="icon-btn" title="定位文件夹"><ExternalLink className="i14" /></button>
                <button onClick={(e) => { e.stopPropagation(); void copyPath(file); }} className="icon-btn" title="复制路径">{copied === file.id ? <Check className="i14 u-success" /> : <Copy className="i14" />}</button>
                {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete(file.id); }} className="icon-btn--danger icon-btn" title="模拟释放空间"><Trash2 className="i14" /></button>}
              </span>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="data-empty">没有找到匹配的文件</div>}
      </div>
      <div className="panel-foot panel-foot--pad4">显示 {filtered.length} 个结果 · 排序方式：文件大小</div>
    </div>
  );
}