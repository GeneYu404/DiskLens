# AGENTS.md

> AI agent / 协作者的工作守则。**先读这页，再动手改东西。**
> 后端架构见 [BACKEND.md](BACKEND.md)，项目说明见 [README.md](README.md)。

## 0. 后端是 Go，不是 Tauri

**2026-10-11 从 Tauri 2 + Rust 整体重写为 Go 1.27 + MyGo 3**（零 CGO）。
`crates/`、`src-tauri/`、`Cargo.toml` / `Cargo.lock` **已删除，不要重建**。

| 现在 | 原来 |
|---|---|
| `internal/core/` | `crates/disklens-core/` |
| `cmd/disklens/` | `crates/disklens-cli/` |
| `internal/shell/` | `src-tauri/src/commands.rs` |
| `main.go` + `mygo.config.ts` | `src-tauri/` + `tauri.conf.json` |
| `src/lib/backend.ts` → `src/mygo.ts` | `invoke("…")` |
| `mygo build` | `tauri build` |
| `golang.org/x/sys/windows` | `windows` crate 0.62 |

## 1. 运行时与包管理器

**前端只用 Bun**（1.4+）。锁文件是 `bun.lock`，**不要**生成 / 提交 `package-lock.json`。
`mygo.config.ts` 里的 `devCommand` / `buildCommand` 必须写 `bun run …`，不是 `npm run …`。

依赖版本与 `D:\Ai\PickScreen` 保持一致：React 19.3.0 / preact 11.0.0（兼容层）/ Vite 8.3.1 / TypeScript 7.0.2。
**已移除** tailwindcss / @tailwindcss/vite / tailwind-merge —— 样式层是手写原生 CSS，见 §6。

Go 侧依赖只有两个：`github.com/egoist/mygo`（v0.3.7）与 `golang.org/x/sys`（v0.49.0）。
**加依赖前先查现有两个能不能解决** —— 原 Rust 版有 60+ crate，现在整棵树只靠这两个。

## 2. 构建与验证

```bash
bun run typecheck     # tsc --noEmit（TS 7 比 5 严格）
bun run build:web     # vite build
gofmt -l .            # 必须无输出
go vet ./...
CGO_ENABLED=0 go build ./...   # 零 CGO 是硬约束
go test ./...
bun run build:exe     # mygo build + 汇总到 build/portable，只出 exe 不出安装包
```

**只出 exe，不打 NSIS 安装包**；需要安装包时用 `mygo build` 后自己从 `build/windows-amd64/` 里取。

### 为什么必须跑 `mygo build` 而不是裸 `go build`

Windows 任务的图标、DPI 感知清单、版本信息是 MyGo 在编译期生成 `.syso` 链接进 exe 的
（见 mygo 的 `winres.go`）。裸 `go build` 会让 exe 退回 Go 默认图标 —— 任务栏、资源管理器、
Alt+Tab 全变丑。

## 3. 构建产物统一归档到 `D:\Tool`

打包好的可执行文件**一律放进 `D:\Tool`**，不要留在项目目录里散落：

- `bun run build:exe` 产出后，把 `DiskLens.exe` 复制到 `D:\Tool\`
- 交付给用户的文件是 `D:\Tool\DiskLens.exe`
- `build/` 下的东西是中间产物，**不是**交付物

## 4. `target` —— 不要手工动

仓库根的 `target` 历史上曾是 **mbx 编译缓存的 symlink**（指向 `D:\mbx\targets\v1\<hash>`）。
**mbx 已卸载**（2026-10-11），该链接随之成为死链并已删除；Go 的编译缓存在 `GOCACHE` 里，
本来就跟它没关系，删掉对构建零影响。

- ❌ 不要自己在这里 `mkdir` 一个真的 `target` 目录「占位」——Go 用不到它，
  建了只会让 `git status` 多一个待忽略项
- ❌ `.gitignore` 里那条规则**不能带尾斜杠**。尾斜杠只匹配目录；万一哪天 `target`
  又以符号链接形态出现，git 看到的是符号链接而非目录，带斜杠的规则匹配不到它，
  会被当 `120000` 条目提交，克隆到别的机器就是死链，而且**本地完全看不出来**。暂存后自查：

```bash
git ls-files -s | Select-String '120000'   # 必须无输出
git check-ignore -v target                 # 必须命中 .gitignore
```

## 5. 图标

`icon.png` 在仓库根，MyGo 的 `mygo.config.ts` 指向它（exe 资源用）。
它是从原 `src-tauri/icons/icon.png` **原封不动搬过来的同一份 PNG**（SHA256 一致），
不是重新生成的。

## 6. 界面：数据色不是界面色

界面走 Windows 11 Fluent 令牌（`src/index.css`，明暗两套），与 `lumina`、`PickScreen`、`Duster` 同一套。
**不要新造硬编码色值**——本项目改造前散落着约 170 种不同的色值。

**2026-10-03 起样式层已从 Tailwind 改为手写原生 CSS**（`228a566`）。`index.css` 1,647 行，
分 `@layer base`（从 Tailwind v4 preflight 抄来的重置）+ `@layer components`（377 个手写语义类）。
组件里写语义类、颜色写 `var(--*)`；`cn()` 只是 `clsx`。**别把 Tailwind 加回来** —— 它靠扫描
源文件猜哪些类被用了，而本项目用 `vite-plugin-singlefile`，上次构建内联进 `dist/index.html` 的
旧类名会被重新扫进去。改完界面记得确认**用到的每个类在 `index.css` 都有定义**，这是手写样式
最常见的静默失败。

**Treemap 的分类色 / 时序色是数据编码，不是界面色**，单列为数据色令牌族
（`--dv-1…--dv-18`、`--cat-*`、`--dv-stale` 等，共 22 个），深色模式下有单独调过的降饱和变体。
**明暗两套都要在 `:root` 和 `:root[data-theme="dark"]` 里各给一次值。**

### canvas 不能用 `var()` —— 本项目特有的坑

同一个颜色字符串会同时喂给两处消费方：

| 消费方 | 能否用 `var(--x)` |
| --- | --- |
| `<span style={{ color }}>`（inline style） | ✅ CSS 原生支持，自动跟随主题 |
| `ctx.fillStyle`（Canvas 2D） | ❌ **不解析，会被静默忽略并沿用上一次填充色** |

所以约定：**调色板（`lib/tree.ts` 的 `getCategory`、`lib/format.ts` 的 `colorForExt`）
统一返回 `var()` 引用**，canvas 侧在绘制前经 `Treemap.tsx` 的 `resolveCssColor` 解析一次。
新增图表时照此办理，否则深色模式下列表对了、图不对。

## 7. MFT 模式需要管理员

`auto` 引擎在没有提权权限时会**静默**回退到 `walk` 并行遍历，整卷扫描慢一个数量级。
不要让用户从扫描速度里自己猜——启动时调 `CheckElevation()` 探一次，
未提升时在 `<main>` 顶部显示醒目提示（`bg-warning-soft` + `ShieldAlert`），
文案要写清后果（回退、更慢）和动作（右键「以管理员身份运行」重启）。

`elevated` 三态：`false` 提示、`true` 不提示、`null` 未知也不提示（探测失败不要误报）。

Go 侧在 `internal/shell/elevation_windows.go`，用 `windows.OpenCurrentProcessToken()` +
`token.IsElevated()`。Rust 版记的那两个坑（windows 0.62 里 `HANDLE` 是新类型、
`TOKEN_ELEVATION::TokenIsElevated` 是 `u32` 不是 `BOOL`）**在 Go 侧不存在** ——
`x/sys` 已经封装好了。唯一要记的是：`OpenCurrentProcessToken` 返回真句柄，
必须 `defer token.Close()`，否则每次探测漏一个。

## 8. Git

分支 `main`，远端 `https://github.com/GeneYu404/DiskLens.git`（public）。
提交身份用已配置的全局值，不要写死别的。

- 消息格式 `<scope>: <一句话>`，例：`fix:` / `feat:` / `docs:` / `chore:`
- 用户没明确要求就**不要 commit / push**
- 删除文件先问用户；`rm` 走运行时可恢复删除，不要用永久删除命令
- force push 默认禁止，且只能用 `--force-with-lease`

## 9. 改动前先核对清单

1. 动到 `target` 忽略规则了吗？→ 见 §4，注意尾斜杠
2. 新加图表色了吗？→ 必须走 `--dv-*` / `--cat-*` 数据色令牌，且明暗两套都要给值，见 §6
3. 新加了 canvas 绘制吗？→ 填色前先 `resolveCssColor`，见 §6
4. 改了 `mygo.config.ts` 的 `identifier` 吗？→ 会连带改应用数据目录；本项目无 `App.Path(PathAppData)` 类调用，改动安全
5. 改了 `tsconfig.json` 的 `paths` 吗？→ TS 7 已移除 `baseUrl`，必须用相对路径 `"./src/*"`
6. 动到扫描引擎选择吗？→ 提权回退必须让用户看得见，见 §7
7. 改了 Go 方法签名吗？→ **重跑 `bun run mygo:generate`**，并同步改 `src/lib/backend.ts` 的参数形状
8. 改了快照 `DLS1` 格式吗？→ `internal/core/query.go` 与 `src/lib/backend.ts` 的 `decodeSnapshot` **两边必须同步**
9. 交付 exe 了吗？→ 见 §3，放 `D:\Tool\`

## 10. 本机 Go 环境的已知地雷

`C:\Program Files\Go\src\cmd\compile\internal\types\universe.go` 的预声明类型表
**缺了 `{"intptr", TINTPTR, TINT32, TINT64}` 那一行**（文件本身完好，是内容被改过）。

后果：**任何用到 `intptr` 的 Go 代码都编译失败**，标准库和第三方模块一样中招。
本项目现有代码全部绕开了（用 `uintptr` / `int32`）。**新代码也请继续绕开**，
不要去「顺手修一下」—— 改 `C:\Program Files` 需要管理员，且会影响全机所有 Go 项目。
若哪天 GOROOT 被修复，这段注释可以删。