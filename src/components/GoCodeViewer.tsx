import { useMemo, useState } from "react";
import { Check, Copy, FileCode2, FolderTree } from "lucide-react";
import goMod from "../../go.mod?raw";
import engineGo from "../../internal/core/engine.go?raw";
import scannerGo from "../../internal/core/scanner_windows.go?raw";
import mftGo from "../../internal/core/mft_parse.go?raw";
import treeGo from "../../internal/core/tree.go?raw";
import queryGo from "../../internal/core/query.go?raw";
import serviceGo from "../../internal/shell/service.go?raw";
import cliGo from "../../cmd/disklens/main.go?raw";

interface SourceFile {
  path: string;
  group: string;
  description: string;
  code: string;
}

/** 直接引用仓库中的 Go 源码，界面展示的内容与实际后端保持一致。 */
const FILES: SourceFile[] = [
  { group: "internal/core", path: "internal/core/engine.go", description: "扫描入口：引擎选择、MFT 失败自动回退、原子进度计数器", code: engineGo },
  { group: "internal/core", path: "internal/core/scanner_windows.go", description: "goroutine 并行遍历，跳过 junction，按目录批量更新进度", code: scannerGo },
  { group: "internal/core", path: "internal/core/mft_parse.go", description: "NTFS $MFT 直读：引导扇区、fixup、data runs、并行解析记录、BFS 建树", code: mftGo },
  { group: "internal/core", path: "internal/core/tree.go", description: "扁平树：自底向上汇总、子项按大小排序、删除、Top-N、搜索", code: treeGo },
  { group: "internal/core", path: "internal/core/query.go", description: "面向 UI 的查询：分页、Top-N、剪枝二进制快照", code: queryGo },
  { group: "internal/shell", path: "internal/shell/service.go", description: "MyGo 绑定服务：后台扫描、进度轮询、快照导出、移到回收站", code: serviceGo },
  { group: "cmd/disklens", path: "cmd/disklens/main.go", description: "命令行版本：输出最大的目录、文件与扩展名", code: cliGo },
  { group: "workspace", path: "go.mod", description: "Go module 与依赖（mygo + x/sys，零 CGO）", code: goMod },
];

export default function GoCodeViewer() {
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

/** 极简高亮：注释、构建标签、关键字行分别着色，避免引入额外依赖。 */
function lineClass(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) return "u-fg3 u-italic";
  if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return "u-fg3 u-italic";
  if (/^(package|import|const|var|type|func)\b/.test(trimmed)) return "u-accent u-font-semibold";
  if (/^(module|go|require)\b/.test(trimmed)) return "u-accent u-font-semibold";
  return "u-fg";
}