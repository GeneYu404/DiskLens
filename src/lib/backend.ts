/**
 * MyGo + WebView2 桥接层 (Bridge)
 *
 * 桌面外壳是 Go 1.27 + MyGo 3（2026-10-11 从 Tauri 2 + Rust 重写而来，Rust 版已移除）。
 * 前端业务组件一行没动，只换了这一层。
 *
 * 与 Rust 版的三处协议差异：
 * 1. **二进制以 base64 过桥**：MyGo 把 Go 的 `[]byte` 序列化成 base64 字符串，
 *    Rust 版走的是 `ArrayBuffer`。下面 `fromBase64()` 负责转换。
 * 2. **可选值变成空串**：Rust 的 `Option<String>`（`engine_used` / `message`）在 Go
 *    的位置参数模型里没有对应物，缺省一律是 `""`。这里在出口处还原成 `null`，
 *    组件层看到的类型和语义都没变。
 * 3. **位置参数取代具名对象**：生成的客户端按 Go 方法签名传参，所以这里是
 *    `DiskLens.startScan(path, engine, threads)` 而不是 `invoke('start_scan', {...})`。
 *
 * 若运行在普通浏览器预览环境，所有接口静默降级（isNative() === false），
 * `useDiskScan` 会切到纯前端的演示扫描器。
 */

import { isMyGo } from "mygo-runtime";
import { DiskLens } from "../mygo";
import { FlatTree } from "./tree";

/** 运行在真实的 MyGo WebView2 桌面客户端中时为 true；普通浏览器中为 false（使用演示数据）。 */
export function isNative(): boolean {
  return isMyGo();
}

export interface DriveInfo {
  mountPoint: string;
  name: string;
  fileSystem: string;
  totalBytes: number;
  availableBytes: number;
  removable: boolean;
}

export type BackendStatus = "idle" | "running" | "done" | "cancelled" | "failed";
export type BackendEngine = "auto" | "walk" | "mft";

export interface ProgressDto {
  status: BackendStatus;
  root: string;
  elapsedMs: number;
  engineUsed: BackendEngine | null;
  message: string | null;
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  recordsDone: number;
  recordsTotal: number;
  currentPath: string;
}

export interface ExtStatDto {
  ext: string;
  size: number;
  count: number;
}

export interface DeleteResult {
  path: string;
  freedBytes: number;
  freedFiles: number;
}

/** 后端探测的提权状态 */
export interface ElevationInfo {
  /** 是否以管理员（已提升）身份运行 */
  elevated: boolean;
  /** 面向用户的一句话说明 */
  hint: string;
}

/* ---------------- base64 ⇄ 二进制 ---------------- */

/**
 * MyGo 把 Go 的 `[]byte` 序列化成 base64 字符串（标准 base64，带填充）。
 * 大快照动辄几十 MB，atob + 逐字节 charCodeAt 是这里唯一可接受的写法 ——
 * 比 FileReader 的 blob 路径少一次拷贝。
 */
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Go 的空串 ⇄ 前端的 null。Go 表达不出字符串字面量联合，只能在边界上转。 */
function orNull(s: string | undefined): string | null {
  return s ? s : null;
}

export const backend = {
  listDrives: () => DiskLens.listDrives(),
  checkElevation: () => DiskLens.checkElevation(),
  startScan: (path: string, engine: BackendEngine, threads: number) =>
    DiskLens.startScan(path, engine, threads),
  progress: async (): Promise<ProgressDto> => {
    const dto = await DiskLens.scanProgress();
    return {
      ...dto,
      status: dto.status as BackendStatus,
      engineUsed: orNull(dto.engineUsed) as BackendEngine | null,
      message: orNull(dto.message),
    };
  },
  cancel: () => DiskLens.cancelScan(),
  exportSnapshot: async (maxNodes: number): Promise<Uint8Array> =>
    fromBase64(await DiskLens.exportSnapshot(maxNodes)),
  extStats: (limit: number) => DiskLens.extStats(limit),
  deleteToTrash: (id: number) => DiskLens.deleteToTrash(id),
  reveal: (id: number) => DiskLens.revealInExplorer(id),
};

/** 合并出来的虚拟节点（「其余 N 个文件」）在后端没有对应 ID。 */
export const SYNTHETIC_ID = 0xffffffff;

const SNAP_FLAG_DIR = 1;

/**
 * 解码后端的剪枝快照（格式见 internal/core/query.go 的 ExportSnapshot）。
 * 导出顺序保证父节点先于子节点，可以直接顺序插入前端的 FlatTree。
 *
 * 入参是 Uint8Array 而不是 ArrayBuffer：MyGo 给的 base64 解出来就是这个形状，
 * 中间再包一层 ArrayBuffer 只会让 TS 掉进 ArrayBufferLike / SharedArrayBuffer
 * 的联合类型里，白白多一个断言。
 */
export function decodeSnapshot(input: Uint8Array): { tree: FlatTree; nativeIds: Uint32Array } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "DLS1") throw new Error("快照格式不匹配");

  const count = view.getUint32(4, true);
  const tree = new FlatTree();
  const nativeIds = new Uint32Array(count);
  const decoder = new TextDecoder();
  const nowSecs = Date.now() / 1000;

  let offset = 8;
  for (let i = 0; i < count; i++) {
    const sourceId = view.getUint32(offset, true);
    const parent = view.getInt32(offset + 4, true);
    const size = view.getFloat64(offset + 8, true);
    const fileCount = view.getUint32(offset + 16, true);
    const modified = view.getUint32(offset + 20, true);
    const flags = view.getUint8(offset + 24);
    const nameLength = view.getUint16(offset + 25, true);
    offset += 27;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;

    const daysAgo = modified > 0 ? Math.max(0, Math.round((nowSecs - modified) / 86400)) : 0;
    const id = tree.add(parent, name, size, (flags & SNAP_FLAG_DIR) !== 0, daysAgo);
    tree.fileCount[id] = fileCount;
    nativeIds[id] = sourceId;
  }

  return { tree, nativeIds };
}