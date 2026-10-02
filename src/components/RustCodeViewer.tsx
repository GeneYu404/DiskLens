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
    <div className="code-shell">
      <aside className="code-side">
        <div className="code-side-head">
          <FolderTree className="i14" /> 工程结构
        </div>
        <div className="code-tree">
          {groups.map((group) => (
            <div key={group} className="code-group">
              <div className="code-group-name">{group}</div>
              {FILES.filter((item) => item.group === group).map((item) => {
                const active = item.path === activePath;
                return (
                  <button
                    key={item.path}
                    onClick={() => setActivePath(item.path)}
                    className={`code-file ${active ? "code-file--on" : ""}`}
                  >
                    {active && <span className="code-file-bar" />}
                    <FileCode2 className="i14 u-shrink-0" />
                    <span className="code-file-name">{item.path.split("/").pop()}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <div className="code-main">
        <div className="code-bar">
          <div className="u-min-w-0">
            <select
              value={activePath}
              onChange={(e) => setActivePath(e.target.value)}
              className="code-bar-select"
            >
              {FILES.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.path}
                </option>
              ))}
            </select>
            <div className="code-path">{file.path}</div>
            <div className="code-desc">
              {file.description} · {lines.length} 行
            </div>
          </div>
          <button
            onClick={() => void copy()}
            className="dialog-code-btn"
          >
            {copied ? <Check className="i14 u-success" /> : <Copy className="i14" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <div className="code-body">
          <pre className="code-pre">
            {lines.map((line, index) => (
              <div key={index} className="code-line">
                <span className="code-gutter">{index + 1}</span>
                <code className={`code-text ${lineClass(line)}`}>{line || " "}</code>
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
  if (trimmed.startsWith("//") || trimmed.startsWith("#") && trimmed.startsWith("# ")) return "u-fg3 u-italic";
  if (trimmed.startsWith("#[") || trimmed.startsWith("#![")) return "u-warning";
  if (/^\[.*\]$/.test(trimmed)) return "u-accent u-font-semibold";
  if (/^(pub\s+)?(fn|struct|enum|impl|mod|const|use|type|trait)\b/.test(trimmed)) return "u-accent";
  return "u-fg";
}
