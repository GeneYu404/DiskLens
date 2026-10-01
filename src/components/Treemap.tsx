import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronUp, Copy, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { FlatTree, getCategory } from "../lib/tree";
import { colorForExt, extOf, formatBytes, formatCount } from "../lib/format";
import { squarify, type Tile } from "../lib/treemap";

export type TreemapColorMode = "ext" | "category" | "depth" | "age";

interface Props {
  tree: FlatTree;
  rootId: number;
  version: number;
  selected: number;
  searchQuery: string;
  colorMode: TreemapColorMode;
  onSelect: (id: number) => void;
  onEnter: (id: number) => void;
  onDelete?: (id: number) => void;
  onColorModeChange?: (mode: TreemapColorMode) => void;
}

interface Drawn extends Tile { level: number; }

/**
 * Canvas 2D 的填色无法使用 Tailwind 类，改为绘制时读取 CSS 变量（index.css 的 --dv-*）。
 * fallback 保留原硬编码值，变量缺失时表现与迁移前一致。
 */
const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * 把 `var(--x)` / `var(--x, fb)` 引用解析成真实色值。
 *
 * 列表视图用 inline `style={{ color }}`，CSS 原生支持 var()，能自动跟随主题；
 * 但 Canvas 2D 的 fillStyle 不认 var()（会被静默忽略并沿用上一次填充色），
 * 所以调色板统一返回变量引用，绘制前经这里解析一次。
 */
const resolveCssColor = (c: string): string => {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(c.trim());
  if (!m) return c;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || (m[2] ?? "").trim() || c;
};

interface DvColors {
  series: string[];
  age: string[];
  dir: string;
  canvas: string;
  ink: string;
  ink2: string;
  grid: string;
  hairline: string;
}

const readDvColors = (): DvColors => ({
  series: ["--dv-1", "--dv-2", "--dv-3", "--dv-4", "--dv-5", "--dv-6"]
    .map((name, i) => cssVar(name, ["#0078d4", "#00a3a3", "#107c10", "#ca5010", "#c239b3", "#8764b8"][i])),
  age: [
    cssVar("--dv-3", "#107c10"),
    cssVar("--dv-1", "#0078d4"),
    cssVar("--dv-6", "#8764b8"),
    cssVar("--dv-4", "#ca5010"),
    cssVar("--dv-stale", "#c50f1f"),
  ],
  dir: cssVar("--dv-dir", "#7ab7e8"),
  canvas: cssVar("--dv-canvas", "#f5f7f9"),
  ink: cssVar("--dv-ink", "#1f2933"),
  ink2: cssVar("--dv-ink-2", "#34434f"),
  grid: cssVar("--dv-grid", "#0078d4"),
  hairline: cssVar("--dv-hairline", "rgba(255,255,255,0.88)"),
});

export default function Treemap({
  tree, rootId, version, selected, searchQuery, colorMode, onSelect, onEnter, onDelete, onColorModeChange,
}: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawnRef = useRef<Drawn[]>([]);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [hover, setHover] = useState<{ id: number; x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (tree.count === 0 || tree.size[rootId] <= 0) return [];
    const result: Drawn[] = [];
    const children = tree.children(rootId, true);
    const topItems: { id: number; value: number }[] = [];
    for (let i = 0; i < children.length && i < 450; i++) {
      const id = children[i];
      if (tree.size[id] > 0) topItems.push({ id, value: tree.size[id] });
    }
    const top = squarify(topItems, { x: 4, y: 4, w: size.w - 8, h: size.h - 8 }, 2.5);
    for (const tile of top) {
      result.push({ ...tile, level: 0 });
      if (tree.isDir(tile.id) && tile.w > 52 && tile.h > 45) {
        const sub = tree.children(tile.id, true);
        const items: { id: number; value: number }[] = [];
        for (let i = 0; i < sub.length && i < 120; i++) {
          if (tree.size[sub[i]] > 0) items.push({ id: sub[i], value: tree.size[sub[i]] });
        }
        const titleBand = tile.h > 72 ? 20 : 15;
        const inner = squarify(items, {
          x: tile.x + 3,
          y: tile.y + titleBand,
          w: Math.max(1, tile.w - 6),
          h: Math.max(1, tile.h - titleBand - 3),
        }, 3);
        inner.forEach((child) => result.push({ ...child, level: 1 }));
      }
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, rootId, size.w, size.h, version]);

  const colorOf = useCallback((id: number, level: number, dv: DvColors) => {
    const isDir = tree.isDir(id);
    if (isDir && level === 0) return dv.dir;
    if (colorMode === "depth") {
      const colors = dv.series;
      return colors[(tree.depth[id] || 0) % colors.length];
    }
    if (colorMode === "age") {
      const days = tree.modDaysAgo[id] || 0;
      return days < 7 ? dv.age[0] : days < 30 ? dv.age[1] : days < 90 ? dv.age[2] : days < 365 ? dv.age[3] : dv.age[4];
    }
    const ext = extOf(tree.name(id));
    // 这两支返回的是 CSS 变量引用，需在赋给 fillStyle 前解析
    return resolveCssColor(colorMode === "category" ? getCategory(ext).color : colorForExt(ext));
  }, [tree, colorMode]);

  const matches = useCallback((id: number) => {
    if (!searchQuery.trim()) return false;
    const q = searchQuery.toLowerCase().replace(/^\*\./, ".");
    return tree.name(id).toLowerCase().includes(q);
  }, [searchQuery, tree]);

  useEffect(() => {
    drawnRef.current = layout;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(size.w * dpr));
    canvas.height = Math.max(1, Math.floor(size.h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dv = readDvColors();
    ctx.fillStyle = dv.canvas;
    ctx.fillRect(0, 0, size.w, size.h);

    for (const tile of layout) {
      const dir = tree.isDir(tile.id);
      const match = matches(tile.id);
      ctx.fillStyle = colorOf(tile.id, tile.level, dv);
      ctx.globalAlpha = dir ? (tile.level === 0 ? 0.28 : 0.35) : (tile.level === 0 ? 0.64 : 0.72);
      if (searchQuery && !match) ctx.globalAlpha *= 0.33;
      ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = match ? dv.grid : dv.hairline;
      ctx.lineWidth = match ? 2 : tile.level === 0 ? 2 : 1;
      ctx.strokeRect(tile.x + 0.5, tile.y + 0.5, Math.max(0, tile.w - 1), Math.max(0, tile.h - 1));

      if (tile.level === 0 && tile.w > 54 && tile.h > 20) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(tile.x + 4, tile.y + 2, tile.w - 8, tile.h - 4);
        ctx.clip();
        ctx.textBaseline = "top";
        ctx.font = "600 12px Segoe UI, sans-serif";
        ctx.fillStyle = dv.ink;
        ctx.fillText(tree.name(tile.id), tile.x + 7, tile.y + 5);
        if (tile.h > 38 && tile.w > 75) {
          ctx.font = "11px Segoe UI, sans-serif";
          ctx.fillStyle = dv.ink2;
          ctx.fillText(formatBytes(tree.size[tile.id]), tile.x + 7, tile.y + 21);
        }
        ctx.restore();
      }
    }

    const highlightId = hover?.id ?? selected;
    const target = layout.find((item) => item.id === highlightId);
    if (target) {
      ctx.strokeStyle = dv.grid;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(target.x + 1, target.y + 1, Math.max(1, target.w - 2), Math.max(1, target.h - 2));
    }
  }, [layout, size, tree, hover, selected, colorOf, matches, searchQuery]);

  const pick = (x: number, y: number) => {
    for (let i = drawnRef.current.length - 1; i >= 0; i--) {
      const tile = drawnRef.current[i];
      if (x >= tile.x && x <= tile.x + tile.w && y >= tile.y && y <= tile.y + tile.h) return tile.id;
    }
    return -1;
  };

  const copyPath = async () => {
    if (!hover) return;
    await navigator.clipboard?.writeText(tree.fullPath(hover.id));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const parentId = tree.parent[rootId];
  const pathIds = tree.pathIds(rootId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-fg">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-stroke px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.8} />
          <span className="shrink-0 text-[13px] font-semibold">空间地图</span>
          <span className="mx-1 h-3.5 w-px shrink-0 bg-stroke" />
          <div className="flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-fg2">
            {pathIds.slice(-3).map((id, index) => <span key={id} className="flex min-w-0 items-center gap-1">
              {index > 0 && <span className="text-fg3">/</span>}
              <button onClick={() => onEnter(id)} className={`max-w-[110px] truncate hover:text-accent ${index === pathIds.slice(-3).length - 1 ? "font-medium text-fg2" : ""}`}>{tree.name(id)}</button>
            </span>)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {onColorModeChange && (
            <select value={colorMode} onChange={(e) => onColorModeChange(e.target.value as TreemapColorMode)} className="h-7 max-w-[115px] rounded border border-stroke bg-layer-solid px-1.5 text-[11px] text-fg outline-none hover:bg-subtle sm:max-w-none">
              <option value="category">按类型着色</option>
              <option value="ext">按扩展名着色</option>
              <option value="depth">按目录层级着色</option>
              <option value="age">按修改时间着色</option>
            </select>
          )}
          {parentId >= 0 && (
            <button onClick={() => onEnter(parentId)} className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-fg hover:bg-subtle" title="上一级">
              <ChevronUp className="h-3.5 w-3.5" /> 上一级
            </button>
          )}
          {rootId !== 0 && (
            <button onClick={() => onEnter(0)} className="grid h-7 w-7 place-items-center rounded text-fg2 hover:bg-subtle" title="回到磁盘根目录">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div ref={mapRef} className="relative min-h-0 flex-1 overflow-hidden bg-dataviz-canvas">
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h }}
          className="block h-full w-full cursor-crosshair"
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const id = pick(x, y);
            setHover(id >= 0 ? { id, x, y } : null);
          }}
          onMouseLeave={() => setHover(null)}
          onClick={() => { if (hover) onSelect(hover.id); }}
          onDoubleClick={() => { if (hover && tree.isDir(hover.id)) onEnter(hover.id); }}
        />

        {hover && (
          <div className="pointer-events-none absolute z-10 w-[250px] rounded-md border border-stroke-strong bg-acrylic p-3 shadow-flyout backdrop-blur" style={{ left: Math.min(hover.x + 12, Math.max(8, size.w - 265)), top: Math.min(hover.y + 12, Math.max(8, size.h - 100)) }}>
            <div className="truncate text-[12px] font-semibold text-fg">{tree.name(hover.id)}</div>
            <div className="mt-0.5 truncate text-[10px] text-fg2">{tree.fullPath(hover.id)}</div>
            <div className="mt-2 flex items-center justify-between border-t border-stroke pt-2 text-[11px]">
              <span className="font-semibold tabular-nums text-accent">{formatBytes(tree.size[hover.id])}</span>
              <span className="text-fg2">{tree.isDir(hover.id) ? `${formatCount(tree.fileCount[hover.id])} 个文件` : `.${extOf(tree.name(hover.id))}`}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t border-stroke px-4 text-[10px] text-fg2">
        <span className="truncate">{layout.length} 个区域 · 双击目录可深入查看</span>
        {hover && (
          <div className="pointer-events-auto flex items-center gap-1">
            {tree.isDir(hover.id) && <button onClick={() => onEnter(hover.id)} className="rounded px-2 py-1 hover:bg-subtle">打开目录</button>}
            <button onClick={() => void copyPath()} className="rounded p-1 hover:bg-subtle" title="复制路径">{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}</button>
            {onDelete && <button onClick={() => onDelete(hover.id)} className="rounded p-1 text-danger hover:bg-danger-soft" title="模拟释放空间"><Trash2 className="h-3.5 w-3.5" /></button>}
          </div>
        )}
      </div>
    </div>
  );
}