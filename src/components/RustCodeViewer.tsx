import { useMemo, useState } from "react";
import { Check, Copy, FileCode2, FolderTree } from "lucide-react";
import workspaceToml from "../../Cargo.toml?raw";
import engineRs from "../../crates/disklens-core/src/engine.rs?raw";
import scannerRs from "../../crates/disklens-core/src/scanner.rs?raw";
import mftRs from "../../crates/disklens-core/src/mft.rs?raw";
import treeRs from "../../crates/disklens-core/src/tree.rs?raw";
import queryRs from "../../crates/disklens-core/src/query.rs?raw";
import commandsRs from "../../src-tauri/src/commands.rs?raw";
import cliRs from "../../crates/disklens-cli/src/main.rs?raw";

interface SourceFile {
  path: string;
  group: string;
  description: string;
  code: string;
}

/** 直接引用仓库中的 Rust 源码，界面展示的内容与实际后端保持一致。 */
const FILES: SourceFile[] = [
  { group: "disklens-core", path: "crates/disklens-core/src/engine.rs", description: "扫描入口：引擎选择、MFT 失败自动回退、原子进度计数器", code: engineRs },
  { group: "disklens-core", path: "crates/disklens-core/src/scanner.rs", description: "rayon 工作窃取并行遍历，跳过 junction，按目录批量更新进度", code: scannerRs },
  { group: "disklens-core", path: "crates/disklens-core/src/mft.rs", description: "NTFS $MFT 直读：引导扇区、fixup、data runs、并行解析记录、BFS 建树", code: mftRs },
  { group: "disklens-core", path: "crates/disklens-core/src/tree.rs", description: "40 字节/节点的扁平树：自底向上汇总、子项按大小排序、删除、Top-N、搜索", code: treeRs },
  { group: "disklens-core", path: "crates/disklens-core/src/query.rs", description: "面向 UI 的查询：分页、Top-N、剪枝二进制快照", code: queryRs },
  { group: "src-tauri", path: "src-tauri/src/commands.rs", description: "Tauri IPC 命令：后台扫描、进度轮询、快照导出、移到回收站", code: commandsRs },
  { group: "disklens-cli", path: "crates/disklens-cli/src/main.rs", description: "命令行版本：输出最大的目录、文件与扩展名", code: cliRs },
  { group: "workspace", path: "Cargo.toml", description: "Cargo workspace 与发布优化配置", code: workspaceToml },
];

export default function RustCodeViewer() {
  const [activePath, setActivePath] = useState(FILES[0].path);
  const [copied, setCopied] = useState(false);
  const file = FILES.find((item) => item.path === activePath) ?? FILES[0];
  const lines = useMemo(() => file.code.replace(/\n$/, "").split("\n"), [file]);
  const groups = useMemo(() => [...new Set(FILES.map((item) => item.group))], []);

  const copy = async () => {
    await navigator.clipboard?.writeText(file.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex h-full min-h-0 bg-card text-fg">
      <aside className="flex w-[250px] shrink-0 flex-col border-r border-stroke bg-layer-solid max-md:hidden">
        <div className="flex h-10 items-center gap-2 border-b border-stroke px-4 text-[11px] font-semibold tracking-wide text-fg2">
          <FolderTree className="h-3.5 w-3.5" /> 工程结构
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-2">
          {groups.map((group) => (
            <div key={group} className="mb-2">
              <div className="px-4 py-1 text-[10px] font-semibold text-fg3">{group}</div>
              {FILES.filter((item) => item.group === group).map((item) => {
                const active = item.path === activePath;
                return (
                  <button
                    key={item.path}
                    onClick={() => setActivePath(item.path)}
                    className={`relative flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px] ${
                      active ? "bg-accent-soft font-semibold text-accent" : "text-fg hover:bg-subtle"
                    }`}
                  >
                    {active && <span className="absolute bottom-1 left-0 top-1 w-[3px] rounded-r bg-accent" />}
                    <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{item.path.split("/").pop()}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stroke px-4 py-2">
          <div className="min-w-0">
            <select
              value={activePath}
              onChange={(e) => setActivePath(e.target.value)}
              className="mb-1 hidden rounded border border-stroke px-2 py-1 text-[12px] max-md:block"
            >
              {FILES.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.path}
                </option>
              ))}
            </select>
            <div className="truncate font-mono text-[12px] font-semibold text-fg">{file.path}</div>
            <div className="truncate text-[11px] text-fg2">
              {file.description} · {lines.length} 行
            </div>
          </div>
          <button
            onClick={() => void copy()}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-stroke bg-card px-2.5 text-[11px] hover:bg-subtle"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-app">
          <pre className="select-text py-3 font-mono text-[12px] leading-[1.65]">
            {lines.map((line, index) => (
              <div key={index} className="flex hover:bg-subtle">
                <span className="w-12 shrink-0 select-none pr-4 text-right text-fg3">{index + 1}</span>
                <code className={`whitespace-pre pr-6 ${lineClass(line)}`}>{line || " "}</code>
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}

/** 极简高亮：注释、属性、关键字行分别着色，避免引入额外依赖。 */
function lineClass(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#") && trimmed.startsWith("# ")) return "text-fg3 italic";
  if (trimmed.startsWith("#[") || trimmed.startsWith("#![")) return "text-warning";
  if (/^\[.*\]$/.test(trimmed)) return "text-accent font-semibold";
  if (/^(pub\s+)?(fn|struct|enum|impl|mod|const|use|type|trait)\b/.test(trimmed)) return "text-accent";
  return "text-fg";
}
