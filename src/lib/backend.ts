import { invoke } from "@tauri-apps/api/core";
import { FlatTree } from "./tree";

/** 运行在 Tauri 桌面壳中时为 true；普通浏览器中为 false（使用演示数据）。 */
export function isNative(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

export const backend = {
  listDrives: () => invoke<DriveInfo[]>("list_drives"),
  checkElevation: () => invoke<ElevationInfo>("check_elevation"),
  startScan: (path: string, engine: BackendEngine, threads: number) =>
    invoke<void>("start_scan", { path, engine, threads }),
  progress: () => invoke<ProgressDto>("scan_progress"),
  cancel: () => invoke<void>("cancel_scan"),
  exportSnapshot: async (maxNodes: number): Promise<ArrayBuffer> => {
    const result = await invoke<ArrayBuffer | number[]>("export_snapshot", { maxNodes });
    return Array.isArray(result) ? new Uint8Array(result).buffer : result;
  },
  extStats: (limit: number) => invoke<ExtStatDto[]>("ext_stats", { limit }),
  deleteToTrash: (id: number) => invoke<DeleteResult>("delete_to_trash", { id }),
  reveal: (id: number) => invoke<void>("reveal_in_explorer", { id }),
};

/** 合并出来的虚拟节点（「其余 N 个文件」）在后端没有对应 ID。 */
export const SYNTHETIC_ID = 0xffffffff;

const SNAP_FLAG_DIR = 1;

/**
 * 解码后端的剪枝快照（格式见 crates/disklens-core/src/query.rs）。
 * 导出顺序保证父节点先于子节点，可以直接顺序插入前端的 FlatTree。
 */
export function decodeSnapshot(buffer: ArrayBuffer): { tree: FlatTree; nativeIds: Uint32Array } {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
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
