# AGENTS.md

> AI agent / 协作者的工作守则。**先读这页，再动手改东西。**
> 后端架构见 [BACKEND.md](BACKEND.md)，项目说明见 [README.md](README.md)。

## 1. 运行时与包管理器

**只用 Bun**（1.4+）。锁文件是 `bun.lock`，**不要**生成 / 提交 `package-lock.json`。
不要主动 `npm install`；`src-tauri/tauri.conf.json` 里的 `beforeDevCommand` / `beforeBuildCommand`
必须写 `bun run …`，不是 `npm run …`。

依赖版本与 `D:\Ai\PickScreen` 保持一致：React 19.3.0 / Tailwind 4.3.3 / Vite 8.3.1 / TypeScript 7.0.2。

## 2. 构建与验证

```bash
bun run typecheck     # tsc --noEmit（TS 7 比 5 严格）
bun run build         # vite build
bun run build:exe     # = tauri build --no-bundle，不出安装包
```

**只出 exe，不打 NSIS 安装包**；需要安装包时用 `bun run tauri build`。

改到 Rust 时追加 `cargo check -p disklens-core` 与 `cargo test -p disklens-core`。

## 3. 构建产物统一归档到 `D:\Tool`

打包好的可执行文件**一律放进 `D:\Tool`**，不要留在项目目录里散落：

- `bun run build:exe` 产出后，把 `disklens.exe` 复制到 `D:\Tool\`
- 交付给用户的文件是 `D:\Tool\disklens.exe`
- `target/release/` 属 mbx 构建缓存，**不是**交付物

## 4. `target` —— 绝对不能动

它是 **mbx 缓存 symlink**（mode `l----` → `D:\mbx\targets\v1\<hash>`）。

- ❌ `rm -rf` / `rmdir` / `mkdir` 这个路径，也不要手工删建来「清理」
- ✅ 损坏时走 `mbx clean && mbx adopt`
- ❌ `.gitignore` 里那条规则**不能带尾斜杠**。尾斜杠只匹配目录，git 看到的是符号链接，
  加了斜杠规则会失效，target 被当 `120000` 条目提交，克隆到别的机器就是指向
  `D:\mbx\...` 的死链，而且**本地完全看不出来**。暂存后自查：

```bash
git ls-files -s | Select-String '120000'   # 必须无输出
git check-ignore -v target                 # 必须命中 .gitignore
```

## 5. `src-tauri/icons/` —— 曾经缺失

`tauri.conf.json` 的 `bundle.icon` 列了 5 个图标，但这些文件**不是仓库自带的**，
需从 `src-tauri/app-icon.svg` 生成。缺失会导致 `bun run build:exe` 直接失败：

```bash
bun run tauri icon src-tauri/app-icon.svg
```

同理 `@tauri-apps/cli` 必须留在 `devDependencies`，缺了跑不了 `tauri icon` / `tauri dev`。

## 6. 界面：数据色不是界面色

界面走 Windows 11 Fluent 令牌（`src/index.css`，明暗两套），与 `lumina`、`PickScreen` 同一套。
**不要新造硬编码色值**——本项目改造前散落着约 170 种不同的色值。

**Treemap 的分类色 / 时序色是数据编码，不是界面色**，单列为 `dataviz-*` 令牌族
（`--dv-1…--dv-18`、`--cat-*`、`--dv-stale` 等），深色模式下有单独调过的降饱和变体。

### canvas 不能用 `var()` —— 本项目特有的坑

同一个颜色字符串会同时喂给两处消费方：

| 消费方 | 能否用 `var(--x)` |
| --- | --- |
| `<span style={{ color }}>`（inline style） | ✅ CSS 原生支持，自动跟随主题 |
| `ctx.fillStyle`（Canvas 2D） | ❌ **不解析，会被静默忽略并沿用上一次填充色** |

所以约定：**调色板（`lib/tree.ts` 的 `getCategory`、`lib/format.ts` 的 `colorForExt`）
统一返回 `var()` 引用**，canvas 侧在绘制前经 `Treemap.tsx` 的 `resolveCssColor` 解析一次。
新增图表时照此办理，否则深色模式下列表对了、图不对。

## 7. Git

分支 `main`，远端 `https://github.com/GeneYu404/DiskLens.git`（public）。
提交身份用已配置的全局值，不要写死别的。

- 消息格式 `<scope>: <一句话>`，例：`fix:` / `feat:` / `docs:` / `chore:`
- 用户没明确要求就**不要 commit / push**
- 删除文件先问用户；`rm` 走运行时可恢复删除，不要用永久删除命令
- force push 默认禁止，且只能用 `--force-with-lease`

## 8. 改动前先核对清单

1. 动到 `target` 忽略规则了吗？→ 见 §4，注意尾斜杠
2. 新加图表色了吗？→ 必须走 `dataviz-*` 令牌，且明暗两套都要给值，见 §6
3. 新加了 canvas 绘制吗？→ 填色前先 `resolveCssColor`，见 §6
4. 改了 `tauri.conf.json` 的 `identifier` 吗？→ 会连带改应用数据目录；本项目无 `app_data_dir` 类调用，改动安全
5. 改了 `tsconfig.json` 的 `paths` 吗？→ TS 7 已移除 `baseUrl`，必须用相对路径 `"./src/*"`
6. 交付 exe 了吗？→ 见 §3，放 `D:\Tool\`
