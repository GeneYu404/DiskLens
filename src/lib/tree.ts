import { extOf } from "./format";

export const FLAG_DIR = 1;
export const FLAG_DELETED = 2;

export type FileCategory =
  | "system"
  | "archive"
  | "video"
  | "audio"
  | "image"
  | "code"
  | "document"
  | "game"
  | "other";

export function getCategory(ext: string): { cat: FileCategory; label: string; color: string } {
  const e = ext.toLowerCase();
  if (["dll", "sys", "exe", "drv", "mui", "pdb", "cat", "msi"].includes(e)) {
    return { cat: "system", label: "系统/二进制", color: "var(--cat-system)" }; // sky
  }
  if (["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "iso", "vhdx", "vmdk"].includes(e)) {
    return { cat: "archive", label: "压缩包/镜像", color: "var(--cat-archive)" }; // amber
  }
  if (["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv"].includes(e)) {
    return { cat: "video", label: "视频媒体", color: "var(--cat-video)" }; // pink
  }
  if (["mp3", "flac", "wav", "aac", "ogg", "m4a"].includes(e)) {
    return { cat: "audio", label: "音频文件", color: "var(--cat-audio)" }; // purple
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "psd", "raw"].includes(e)) {
    return { cat: "image", label: "图像素材", color: "var(--cat-image)" }; // emerald
  }
  if (["ts", "tsx", "js", "jsx", "rs", "cpp", "c", "h", "py", "go", "json", "toml", "yaml", "html", "css"].includes(e)) {
    return { cat: "code", label: "源码/配置", color: "var(--cat-code)" }; // cyan
  }
  if (["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "log"].includes(e)) {
    return { cat: "document", label: "文档/日志", color: "var(--cat-document)" }; // indigo
  }
  if (["pak", "bundle", "unity3d", "asset", "bik", "sav"].includes(e)) {
    return { cat: "game", label: "游戏资产", color: "var(--cat-game)" }; // orange
  }
  return { cat: "other", label: "其他格式", color: "var(--cat-other)" }; // slate
}

export interface ExtInfo {
  ext: string;
  size: number;
  count: number;
  cat: FileCategory;
  color: string;
  categoryLabel: string;
}

export interface FlatFileSummary {
  id: number;
  name: string;
  path: string;
  size: number;
  ext: string;
  modTime: number; // timestamp
}

/**
 * 扁平化紧凑内存结构：
 * 百万级文件放进连续 TypedArray，极致缓存亲和力。
 */
export class FlatTree {
  cap = 2048;
  count = 0;

  size = new Float64Array(this.cap);
  originalSize = new Float64Array(this.cap);
  fileCount = new Float64Array(this.cap);
  parent = new Int32Array(this.cap);
  firstChild = new Int32Array(this.cap);
  lastChild = new Int32Array(this.cap);
  nextSibling = new Int32Array(this.cap);
  childCount = new Int32Array(this.cap);
  depth = new Uint8Array(this.cap);
  flags = new Uint8Array(this.cap);
  nameIdx = new Int32Array(this.cap);
  modDaysAgo = new Uint16Array(this.cap); // 修改距今的天数 (0~65535)

  names: string[] = [];
  private nameMap = new Map<string, number>();
  private sortedCache = new Map<number, Int32Array>();

  extStats = new Map<string, { size: number; count: number }>();
  freedBytes = 0;
  freedFiles = 0;

  private grow() {
    const cap = this.cap * 2;
    const copyF = (a: Float64Array) => {
      const n = new Float64Array(cap);
      n.set(a);
      return n;
    };
    const copyI = (a: Int32Array) => {
      const n = new Int32Array(cap);
      n.set(a);
      return n;
    };
    const copyU8 = (a: Uint8Array) => {
      const n = new Uint8Array(cap);
      n.set(a);
      return n;
    };
    const copyU16 = (a: Uint16Array) => {
      const n = new Uint16Array(cap);
      n.set(a);
      return n;
    };

    this.size = copyF(this.size);
    this.originalSize = copyF(this.originalSize);
    this.fileCount = copyF(this.fileCount);
    this.parent = copyI(this.parent);
    this.firstChild = copyI(this.firstChild);
    this.lastChild = copyI(this.lastChild);
    this.nextSibling = copyI(this.nextSibling);
    this.childCount = copyI(this.childCount);
    this.depth = copyU8(this.depth);
    this.flags = copyU8(this.flags);
    this.nameIdx = copyI(this.nameIdx);
    this.modDaysAgo = copyU16(this.modDaysAgo);
    this.cap = cap;
  }

  internName(name: string): number {
    const hit = this.nameMap.get(name);
    if (hit !== undefined) return hit;
    const idx = this.names.length;
    this.names.push(name);
    if (this.nameMap.size < 250000) this.nameMap.set(name, idx);
    return idx;
  }

  add(parent: number, name: string, size: number, isDir: boolean, daysAgo = 15): number {
    if (this.count >= this.cap) this.grow();
    const id = this.count++;
    this.size[id] = size;
    this.originalSize[id] = size;
    this.fileCount[id] = isDir ? 0 : 1;
    this.parent[id] = parent;
    this.firstChild[id] = -1;
    this.lastChild[id] = -1;
    this.nextSibling[id] = -1;
    this.childCount[id] = 0;
    this.flags[id] = isDir ? FLAG_DIR : 0;
    this.nameIdx[id] = this.internName(name);
    this.depth[id] = parent < 0 ? 0 : Math.min(255, this.depth[parent] + 1);
    this.modDaysAgo[id] = Math.min(65535, daysAgo);

    if (parent >= 0) {
      const last = this.lastChild[parent];
      if (last < 0) this.firstChild[parent] = id;
      else this.nextSibling[last] = id;
      this.lastChild[parent] = id;
      this.childCount[parent]++;
    }
    return id;
  }

  bubble(id: number, size: number, files: number) {
    let p = this.parent[id];
    while (p >= 0) {
      this.size[p] += size;
      this.originalSize[p] += size;
      this.fileCount[p] += files;
      p = this.parent[p];
    }
  }

  isDir(id: number): boolean {
    return (this.flags[id] & FLAG_DIR) !== 0;
  }

  isDeleted(id: number): boolean {
    return (this.flags[id] & FLAG_DELETED) !== 0;
  }

  name(id: number): string {
    return this.names[this.nameIdx[id]] || "";
  }

  pathIds(id: number): number[] {
    const out: number[] = [];
    let c = id;
    while (c >= 0) {
      out.push(c);
      c = this.parent[c];
    }
    return out.reverse();
  }

  path(id: number): number[] {
    return this.pathIds(id);
  }

  fullPath(id: number): string {
    const ids = this.pathIds(id);
    if (ids.length === 0) return "";
    let s = this.name(ids[0]);
    if (!s.endsWith("\\") && !s.endsWith("/")) s += "\\";
    for (let i = 1; i < ids.length; i++) {
      s += (i === 1 ? "" : "\\") + this.name(ids[i]);
    }
    return s;
  }

  children(id: number, filterActive = false): Int32Array {
    const hit = this.sortedCache.get(id);
    if (hit) return hit;
    const arr: number[] = [];
    let c = this.firstChild[id];
    while (c >= 0) {
      if (!filterActive || !this.isDeleted(c)) {
        arr.push(c);
      }
      c = this.nextSibling[c];
    }
    arr.sort((a, b) => this.size[b] - this.size[a]);
    const sorted = Int32Array.from(arr);
    if (this.sortedCache.size > 5000) this.sortedCache.clear();
    this.sortedCache.set(id, sorted);
    return sorted;
  }

  invalidate() {
    this.sortedCache.clear();
  }

  addExt(name: string, size: number) {
    const ext = extOf(name);
    const s = this.extStats.get(ext);
    if (s) {
      s.size += size;
      s.count++;
    } else {
      this.extStats.set(ext, { size, count: 1 });
    }
  }

  /**
   * 模拟释放/清理文件空间 (WizTree 删除测试)
   */
  simulateDelete(id: number): { freedBytes: number; freedFiles: number } {
    if (this.isDeleted(id)) return { freedBytes: 0, freedFiles: 0 };

    const freedBytes = this.size[id];
    const freedFiles = this.isDir(id) ? this.fileCount[id] : 1;

    // 递归标记为已删除
    const markRec = (cur: number) => {
      this.flags[cur] |= FLAG_DELETED;
      let c = this.firstChild[cur];
      while (c >= 0) {
        markRec(c);
        c = this.nextSibling[c];
      }
    };
    markRec(id);

    this.size[id] = 0;
    this.fileCount[id] = 0;

    // 向上减除尺寸
    let p = this.parent[id];
    while (p >= 0) {
      this.size[p] = Math.max(0, this.size[p] - freedBytes);
      this.fileCount[p] = Math.max(0, this.fileCount[p] - freedFiles);
      p = this.parent[p];
    }

    this.freedBytes += freedBytes;
    this.freedFiles += freedFiles;
    this.invalidate();

    return { freedBytes, freedFiles };
  }

  /**
   * 获取全盘前 N 大文件
   */
  getTopLargestFiles(limit = 100): FlatFileSummary[] {
    const files: { id: number; size: number }[] = [];
    for (let i = 0; i < this.count; i++) {
      if (!this.isDir(i) && !this.isDeleted(i) && this.size[i] > 0) {
        files.push({ id: i, size: this.size[i] });
      }
    }
    files.sort((a, b) => b.size - a.size);
    const top = files.slice(0, limit);
    return top.map((item) => {
      const id = item.id;
      const n = this.name(id);
      return {
        id,
        name: n,
        path: this.fullPath(id),
        size: item.size,
        ext: extOf(n),
        modTime: Date.now() - (this.modDaysAgo[id] || 1) * 86400000,
      };
    });
  }

  /**
   * 扩展名分布统计列表
   */
  getExtSummaryList(): ExtInfo[] {
    const list: ExtInfo[] = [];
    for (const [ext, stat] of this.extStats.entries()) {
      const meta = getCategory(ext);
      list.push({
        ext,
        size: stat.size,
        count: stat.count,
        cat: meta.cat,
        color: meta.color,
        categoryLabel: meta.label,
      });
    }
    list.sort((a, b) => b.size - a.size);
    return list;
  }
}

/* ------------------------------------------------------------------ */
/* 真实文件树生成引擎与扫描器                                         */
/* ------------------------------------------------------------------ */

interface DrivePreset {
  drive: string;
  totalCap: number; // e.g. 512 GB
  targetFiles: number;
  label: string;
  desc: string;
  fsType: string;
}

export const DRIVE_PRESETS: DrivePreset[] = [
  {
    drive: "C:\\",
    label: "系统固态盘 (OS_SSD)",
    targetFiles: 380_000,
    totalCap: 512 * 1024 * 1024 * 1024,
    desc: "Windows 11 系统盘，包含 WinSxS, Docker, node_modules 与 Rust target",
    fsType: "NTFS",
  },
  {
    drive: "D:\\",
    label: "高性能媒体库 (NVMe_PRO)",
    targetFiles: 720_000,
    totalCap: 2048 * 1024 * 1024 * 1024,
    desc: "4K 影视工程剪辑、Steam 游戏大作安装包、Blender 渲染缓存",
    fsType: "NTFS",
  },
  {
    drive: "E:\\",
    label: "数据冷备池 (HDD_ARCHIVE)",
    targetFiles: 1_250_000,
    totalCap: 4096 * 1024 * 1024 * 1024,
    desc: "VMware 镜像、SQL 备份包、RAW 摄影原片存档与旧项目仓库",
    fsType: "NTFS",
  },
];

const REAL_DIR_NAMES = [
  "Windows", "System32", "WinSxS", "Program Files", "Common Files", "ProgramData",
  "Users", "Administrator", "AppData", "Local", "Roaming", "LocalLow", "Packages",
  "Microsoft", "VisualStudio", "JetBrains", "RustRover", "Rust", ".cargo", "target",
  "node_modules", "src", "dist", "build", "public", "assets", "cache", "releases",
  "SteamLibrary", "steamapps", "common", "Cyberpunk 2077", "Black Myth Wukong",
  "Docker", "wsl", "data", "ext4.vhdx", "VMware", "VirtualBox VMs", "iso", "backups",
  "Downloads", "Documents", "Pictures", "Videos", "Premiere Projects", "DaVinci Resolve",
  "UnrealEngine", "Engine", "Binaries", "Plugins", "Intermediate", "Saved",
];

const EXT_CONFIG: [string, number, number][] = [
  // ext, weight, typical bytes (log-normal median)
  ["dll", 15, 1_200_000],
  ["sys", 3, 850_000],
  ["exe", 5, 14_000_000],
  ["pak", 4, 380_000_000],
  ["iso", 1, 4_500_000_000],
  ["vhdx", 1, 28_000_000_000],
  ["mp4", 3, 650_000_000],
  ["mkv", 2, 2_800_000_000],
  ["zip", 4, 120_000_000],
  ["tar", 2, 450_000_000],
  ["ts", 12, 14_000],
  ["js", 14, 28_000],
  ["rs", 6, 18_000],
  ["json", 12, 6_000],
  ["png", 8, 380_000],
  ["jpg", 6, 2_400_000],
  ["pdf", 4, 3_200_000],
  ["log", 7, 240_000],
  ["pdb", 4, 25_000_000],
  ["dat", 5, 3_000_000],
];

const TOTAL_WEIGHT = EXT_CONFIG.reduce((a, b) => a + b[1], 0);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Task {
  dir: number;
  budget: number;
  depth: number;
}

export type ScanPhase = "idle" | "mft_boot" | "mft_records" | "rayon_traversal" | "tree_rebuild" | "done" | "cancelled";

export class RealisticScanner {
  tree = new FlatTree();
  root: number;
  private stack: Task[] = [];
  private rnd: () => number;
  cancelled = false;
  target: number;
  dirs = 1;
  phase: ScanPhase = "idle";
  phaseDetail = "";
  phaseProgress = 0; // 0..1

  constructor(driveLabel: string, targetFiles: number, seed = 42) {
    this.rnd = mulberry32(seed);
    this.target = targetFiles;
    this.root = this.tree.add(-1, driveLabel, 0, true, 0);
    this.stack.push({ dir: this.root, budget: targetFiles, depth: 0 });
  }

  get isDone() {
    return (this.stack.length === 0 && this.phase === "done") || this.cancelled;
  }

  get done() {
    return this.isDone;
  }

  private randomSize(median: number) {
    const u = this.rnd() || 1e-9;
    const v = this.rnd() || 1e-9;
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(512, Math.round(median * Math.exp(g * 1.05)));
  }

  private pickExt() {
    let r = this.rnd() * TOTAL_WEIGHT;
    for (const e of EXT_CONFIG) {
      r -= e[1];
      if (r <= 0) return e;
    }
    return EXT_CONFIG[0];
  }

  private dirName(i: number) {
    const w = REAL_DIR_NAMES[(this.rnd() * REAL_DIR_NAMES.length) | 0];
    return this.rnd() < 0.25 ? `${w}_v${i + 1}` : w;
  }

  step(budgetOps: number): number {
    if (this.cancelled) return 0;

    let created = 0;
    while (this.stack.length && created < budgetOps && !this.cancelled) {
      const task = this.stack.pop()!;
      const { dir, budget, depth } = task;

      if (budget <= 0) continue;

      const leafy = budget <= 60 || depth >= 7;
      const fileHere = leafy ? budget : Math.max(1, Math.round(budget * (0.06 + this.rnd() * 0.14)));

      let localSize = 0;
      for (let i = 0; i < fileHere; i++) {
        const [ext, , median] = this.pickExt();
        const size = this.randomSize(median);
        const daysAgo = Math.round(Math.pow(this.rnd(), 2.2) * 900);
        const nameWord = REAL_DIR_NAMES[(this.rnd() * REAL_DIR_NAMES.length) | 0]
          .toLowerCase()
          .replace(/\s+/g, "_");
        const fileName = `${nameWord}_${(this.rnd() * 999) | 0}.${ext}`;

        this.tree.add(dir, fileName, size, false, daysAgo);
        this.tree.addExt(fileName, size);
        localSize += size;
        created++;
      }

      this.tree.size[dir] += localSize;
      this.tree.originalSize[dir] += localSize;
      this.tree.fileCount[dir] += fileHere;
      this.tree.bubble(dir, localSize, fileHere);

      if (!leafy) {
        let rest = budget - fileHere;
        const subCount = 2 + ((this.rnd() * 6) | 0);
        const weights: number[] = [];
        let wsum = 0;
        for (let sIdx = 0; sIdx < subCount; sIdx++) {
          const w = Math.pow(this.rnd(), 1.6) + 0.05;
          weights.push(w);
          wsum += w;
        }
        for (let i = 0; i < subCount && rest > 0; i++) {
          const share =
            i === subCount - 1
              ? rest
              : Math.min(rest, Math.round((weights[i] / wsum) * (budget - fileHere)));
          if (share <= 0) continue;
          const subDir = this.tree.add(dir, this.dirName(i), 0, true, Math.round(this.rnd() * 60));
          this.dirs++;
          this.stack.push({ dir: subDir, budget: share, depth: depth + 1 });
          rest -= share;
        }
      }
    }

    if (this.stack.length === 0) {
      this.phase = "done";
      this.phaseDetail = "扫描就绪 · 结构树已缓存";
    }

    this.tree.invalidate();
    return created;
  }

  cancel() {
    this.cancelled = true;
    this.stack.length = 0;
    this.phase = "cancelled";
    this.phaseDetail = "用户已中止扫描";
  }

  stats() {
    const t = this.tree;
    return {
      files: t.fileCount[this.root],
      dirs: this.dirs,
      bytes: t.size[this.root],
      freedBytes: t.freedBytes,
      freedFiles: t.freedFiles,
      nodeCount: t.count,
    };
  }
}

export type Scanner = RealisticScanner;
export const Scanner = RealisticScanner;
