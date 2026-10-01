export function formatBytes(n: number): string {
  if (n < 1024) return `${n | 0} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * 扩展名分类色板。
 * 这里是「数据可视化色」而非界面色，因此返回 CSS 变量引用：
 * 同一字符串在 inline style（<span style={{ color }}>）里可直接生效并自动跟随主题；
 * 唯一不能直接用的地方是 Treemap 的 ctx.fillStyle —— Canvas 2D 不解析 var()，
 * 那里会在绘制前经 `resolveCssColor` 统一解析（见 components/Treemap.tsx）。
 */
const PALETTE = [
  "var(--dv-7)", "var(--dv-8)", "var(--dv-9)", "var(--dv-10)", "var(--dv-11)", "var(--dv-12)",
  "var(--dv-13)", "var(--dv-14)", "var(--dv-15)", "var(--dv-16)", "var(--dv-17)", "var(--dv-18)",
];

export function colorForExt(ext: string): string {
  let h = 2166136261;
  for (let i = 0; i < ext.length; i++) {
    h ^= ext.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "(无扩展名)";
}
