import { useCallback, useEffect, useRef, useState } from "react";
import { DRIVE_PRESETS, FlatTree, RealisticScanner } from "./tree";
import { backend, decodeSnapshot, isNative, SYNTHETIC_ID, type DriveInfo, type ProgressDto } from "./backend";
import { formatBytes } from "./format";

export type EngineChoice = "mft" | "rayon";
export type ScanStatus = "idle" | "running" | "done" | "cancelled" | "failed";

export interface DriveOption {
  drive: string;
  label: string;
  desc: string;
  fsType: string;
  totalCap: number;
  /** 已用空间（本机模式下用于估算进度），演示模式为 0。 */
  usedBytes: number;
  /** 演示模式要生成的文件数。 */
  targetFiles: number;
}

export interface ScanStats {
  files: number;
  dirs: number;
  bytes: number;
  freedBytes: number;
  nodeCount: number;
}

/** 前端最多接收的节点数；更小的项在后端合并为「其余 N 个文件」。 */
const SNAPSHOT_NODES = 250_000;
const EMPTY_STATS: ScanStats = { files: 0, dirs: 0, bytes: 0, freedBytes: 0, nodeCount: 0 };

const DEMO_DRIVES: DriveOption[] = DRIVE_PRESETS.map((preset) => ({
  drive: preset.drive,
  label: preset.label,
  desc: preset.desc,
  fsType: preset.fsType,
  totalCap: preset.totalCap,
  usedBytes: 0,
  targetFiles: preset.targetFiles,
}));

function toDriveOption(info: DriveInfo): DriveOption {
  const used = Math.max(0, info.totalBytes - info.availableBytes);
  return {
    drive: info.mountPoint,
    label: info.name || (info.removable ? "可移动磁盘" : "本地磁盘"),
    desc: `${info.fileSystem || "未知文件系统"} · 已用 ${formatBytes(used)} / 共 ${formatBytes(info.totalBytes)}`,
    fsType: info.fileSystem || "—",
    totalCap: info.totalBytes,
    usedBytes: used,
    targetFiles: 0,
  };
}

/**
 * 扫描状态管理：
 * - 本机模式（Tauri）：调用 Rust 后端，每 100ms 读取一次进度，完成后拉取剪枝快照；
 * - 演示模式（浏览器）：在前端按帧分片生成模拟文件树。
 */
export function useDiskScan() {
  const native = isNative();
  const [drives, setDrives] = useState<DriveOption[]>(native ? [] : DEMO_DRIVES);
  const [tree, setTree] = useState<FlatTree | null>(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [stats, setStats] = useState<ScanStats>(EMPTY_STATS);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [engineUsed, setEngineUsed] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");

  const scannerRef = useRef<RealisticScanner | null>(null);
  const rafRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  const nativeIdsRef = useRef<Uint32Array | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const stopTimers = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    rafRef.current = null;
    pollRef.current = null;
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  useEffect(() => {
    if (!native) return;
    backend
      .listDrives()
      .then((list) => setDrives(list.map(toDriveOption)))
      .catch((error) => setMessage(`读取磁盘列表失败：${String(error)}`));
  }, [native]);

  /* ---------------- 演示模式 ---------------- */
  const startDemo = useCallback(
    (drive: DriveOption, index: number, engine: EngineChoice, threads: number) => {
      const scanner = new RealisticScanner(drive.drive, drive.targetFiles, 2025 + index * 19);
      scannerRef.current = scanner;
      setTree(scanner.tree);
      setEngineUsed(engine === "mft" ? "mft" : "walk");

      const startedAt = performance.now();
      let lastPublish = startedAt;
      const batch = Math.round(750 * threads * (engine === "mft" ? 4.5 : 1.4));

      const tick = () => {
        const current = scannerRef.current;
        if (current !== scanner || scanner.cancelled) return;

        const frameStart = performance.now();
        let produced = 0;
        // 单帧最多占用 12ms，保证界面不掉帧
        while (!scanner.done && produced < batch && performance.now() - frameStart < 12) {
          produced += scanner.step(1800);
        }

        const now = performance.now();
        if (now - lastPublish > 100 || scanner.done) {
          lastPublish = now;
          const snapshot = scanner.stats();
          setElapsed(now - startedAt);
          setStats(snapshot);
          setProgress(Math.min(1, snapshot.files / scanner.target));
          bump();
        }

        if (scanner.done) {
          rafRef.current = null;
          setStatus("done");
          setProgress(1);
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [bump]
  );

  /* ---------------- 本机模式 ---------------- */
  const loadNativeResult = useCallback(async (dto: ProgressDto) => {
    try {
      const [buffer, extensions] = await Promise.all([
        backend.exportSnapshot(SNAPSHOT_NODES),
        backend.extStats(300),
      ]);
      const { tree: loaded, nativeIds } = decodeSnapshot(buffer);
      loaded.extStats = new Map(
        extensions.map((item) => [item.ext || "(无扩展名)", { size: item.size, count: item.count }])
      );
      nativeIdsRef.current = nativeIds;
      setTree(loaded);
      setStats({
        files: dto.files,
        dirs: dto.dirs,
        bytes: loaded.count > 0 ? loaded.size[0] : dto.bytes,
        freedBytes: 0,
        nodeCount: dto.files + dto.dirs,
      });
    } catch (error) {
      if (dto.status === "done") setMessage(`加载扫描结果失败：${String(error)}`);
    }
  }, []);

  const startNative = useCallback(
    async (drive: DriveOption, engine: EngineChoice, threads: number) => {
      setTree(null);
      nativeIdsRef.current = null;
      try {
        await backend.startScan(drive.drive, engine === "mft" ? "auto" : "walk", threads);
      } catch (error) {
        setStatus("failed");
        setMessage(String(error));
        return;
      }

      let busy = false;
      pollRef.current = window.setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const dto = await backend.progress();
          setElapsed(dto.elapsedMs);
          setCurrentPath(dto.currentPath);
          setStats((prev) => ({ ...prev, files: dto.files, dirs: dto.dirs, bytes: dto.bytes, nodeCount: dto.files + dto.dirs }));

          const readingMft = dto.recordsTotal > 0 && dto.files === 0;
          const ratio = readingMft
            ? dto.recordsDone / dto.recordsTotal
            : drive.usedBytes > 0
              ? dto.bytes / drive.usedBytes
              : 0;
          setProgress(Math.min(0.99, ratio));

          if (dto.status !== "running") {
            stopTimers();
            setEngineUsed(dto.engineUsed);
            setMessage(dto.message);
            if (dto.status === "done" || dto.status === "cancelled") await loadNativeResult(dto);
            setStatus(dto.status === "idle" ? "done" : dto.status);
            if (dto.status === "done") setProgress(1);
            bump();
          }
        } catch (error) {
          stopTimers();
          setStatus("failed");
          setMessage(String(error));
        } finally {
          busy = false;
        }
      }, 100);
    },
    [bump, loadNativeResult, stopTimers]
  );

  /* ---------------- 公共接口 ---------------- */
  const start = useCallback(
    (index: number, engine: EngineChoice, threads: number) => {
      const drive = drives[index];
      if (!drive) return;
      stopTimers();
      scannerRef.current = null;
      setStatus("running");
      setElapsed(0);
      setStats(EMPTY_STATS);
      setProgress(0);
      setMessage(null);
      setEngineUsed(null);
      setCurrentPath(drive.drive);
      bump();
      if (native) void startNative(drive, engine, threads);
      else startDemo(drive, index, engine, threads);
    },
    [drives, native, startDemo, startNative, stopTimers, bump]
  );

  const cancel = useCallback(() => {
    if (native) {
      void backend.cancel(); // 轮询会读取到 cancelled 状态并加载已扫描部分
      return;
    }
    const scanner = scannerRef.current;
    scanner?.cancel();
    stopTimers();
    setStatus("cancelled");
    if (scanner) setStats(scanner.stats());
    bump();
  }, [native, stopTimers, bump]);

  const deleteNode = useCallback(
    async (id: number) => {
      if (!tree || id <= 0) return;
      if (native) {
        const sourceId = nativeIdsRef.current?.[id];
        if (sourceId === undefined || sourceId === SYNTHETIC_ID) {
          setMessage("这是合并显示的小文件集合，请进入具体目录后再删除");
          return;
        }
        if (!window.confirm(`确定要将“${tree.fullPath(id)}”移到回收站吗？`)) return;
        try {
          await backend.deleteToTrash(sourceId);
        } catch (error) {
          setMessage(String(error));
          return;
        }
      }
      tree.simulateDelete(id);
      setStats((prev) => ({ ...prev, bytes: tree.size[0], files: tree.fileCount[0], freedBytes: tree.freedBytes }));
      bump();
    },
    [tree, native, bump]
  );

  const reveal = useCallback(
    (id: number) => {
      const sourceId = nativeIdsRef.current?.[id];
      if (!native || sourceId === undefined || sourceId === SYNTHETIC_ID) return;
      backend.reveal(sourceId).catch((error) => setMessage(String(error)));
    },
    [native]
  );

  return {
    native,
    drives,
    tree,
    version,
    bump,
    status,
    scanning: status === "running",
    elapsed,
    stats,
    progress,
    message,
    engineUsed,
    currentPath,
    start,
    cancel,
    deleteNode,
    reveal,
  };
}
