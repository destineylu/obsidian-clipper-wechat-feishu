# 官方更新纳入实施方案（Upstream Sync Playbook）

> 本程序（fork）以官方 `obsidianmd/obsidian-clipper` 为上游，自定义功能（飞书 / 微信 / B 站 / 抖音 / 小红书 / X / GitHub）全部隔离在 `src/platforms/*`，通过少量"稳定钩子"接入上游代码。本文档说明：当官方发布新版本时，如何把官方更新干净地合并进本程序。
>
> 本方案与 `UPSTREAM_BOUNDARY.md` 配套使用：前者讲"边界约定"，本文讲"执行流程"。

---

## 一、本程序已有的同步基础（运行机制）

这套流程已在 1.7.1 上实际执行过，由四个支柱构成：

1. **`upstream` git remote**
   `https://github.com/obsidianmd/obsidian-clipper.git` 已在本地配置，可直接 `git fetch upstream`。

2. **版本同步脚本** `scripts/sync-official-version.mjs`（`npm run sync:official-version`）
   自动从 **Chrome 应用商店 + GitHub main** 两处读取官方版本号（可用 `OFFICIAL_CLIPPER_VERSION_SOURCE` 配置来源），并对 `package.json`、`package-lock.json` 和三个 manifest（`src/manifest.chrome.json` / `firefox` / `safari`）做版本戳记。
   支持 `--check`（只比对不落盘）与 `--required`（取不到版本时非零退出）。

3. **边界门禁** `scripts/check-custom-platforms.mjs`（`npm run check:custom-platforms`）
   验证两件事：
   - (a) 7 个平台（wechat / github / feishu / bilibili / douyin / xiaohongshu / x）均已注册；
   - (b) 7 个上游"钩子文件"中仍然包含 `platformRegistry.*` 调用。
   合并后如果钩子被覆盖掉，此检查会失败 —— 这是防止"自定义功能被合并静默弄丢"的第一道保险。

4. **CI 自动化**
   - `.github/workflows/sync-official-version.yml`：每天（cron `17 2 * * *`）运行 `sync:official-version --required --check`，官方出新版本时 CI 失败以提醒同步；
   - `.github/workflows/ci.yml`：push / PR 时执行 `npm ci`、`npm run check`（敏感产物 + 钩子门禁 + 类型检查 + 全量 vitest）、`npm run build`（chrome+firefox+safari）、`npm audit`，并以 `git diff --exit-code` 确认构建不改动已跟踪源码。

### 关键架构设计

自定义代码全部隔离在 `src/platforms/*`，上游集成只通过 `UPSTREAM_BOUNDARY.md` 列出的 **7 个"稳定钩子"文件**里各一行 `platformRegistry.*` 调用完成。这就是合并官方更新时冲突面很小的根本原因。

**7 个钩子文件：**
- `src/content.ts` — `beforeDomNormalize` / `afterExtract` / `extractStructuredContent`
- `src/core/reader-view.ts` — `beforeDomNormalize` / `afterExtract` / `extractReaderContent` / `extractStructuredContent`
- `src/background.ts` — `registerPlatformBackgroundHandlers` / `handlePlatformBackgroundMessage`
- `src/utils/clip-utils.ts` — `beforeDomNormalize` / `afterExtract`
- `src/utils/reader.ts` — `extractReaderContent` / `captureReaderState` / `enhanceReader` / `onReaderRestore`
- `src/utils/content-extractor.ts` — `afterMarkdown`
- `src/core/popup.ts` — `saveToObsidian`

---

## 二、1.7.1 实际用到的"快照 + 合并"（vendor-branch）机制

```
eae51b9  chore: snapshot official upstream 1.7.1     ← 父: d5161c0 (custom)，140 个文件，干净官方树
3836c0d  Merge official Obsidian Web Clipper 1.7.1   ← 父: fc548dc (custom main) + eae51b9 (snapshot)
```

**两步法**：先把官方干净的树做成一个独立提交（`eae51b9`，基于当时的自定义状态切入官方 1.7.1 内容），再在自定义 `main` 上用 `git merge --no-ff` 合并它。

1.7.1 的冲突面（`git merge` 输出的 `# Conflicts:`）为：
`README.md`、`package.json`、`package-lock.json`、`3 个 manifest`、`src/background.ts`、`src/content.ts`、`src/utils/content-extractor.ts`、`src/utils/reader.ts`、`src/reader.scss` + 一组 `xcode` 图标。
—— 全部是预期内的"钩子文件 + 版本/元数据"，**没有任何 `src/platforms/*` 冲突**。

---

## 三、详细实施步骤（每次官方发布新版时执行）

### 第 0 步 · 检测新版本（自动，已在运行）
`sync-official-version.yml` 每日检查。CI 失败时，或你想主动同步时手动确认：

```bash
npm run sync:official-version -- --check      # 版本落后则报错退出
```

### 第 1 步 · 抓取官方源
```bash
git fetch upstream main
git tag -l                                    # 上游未打 git tag，靠分支/manifest 版本判断
npm run sync:official-version                 # 仅读出新版本号；戳记放到第 6 步统一做
```

### 第 2 步 · 建官方快照分支（vendor 法）
> 快照必须基于 **已含自定义的 `main`**，保证历史连通、merge 能干净收敛（1.7.1 即如此）。

```bash
git checkout -B sync/official-X.Y.Z main

# 用官方 X.Y.Z 内容覆盖整个工作区（保留 .git）
git checkout upstream/main -- .

# 逐个还原"必须保持 fork 版"的文件（边界门禁 + 自定义 CI + 版本脚本）：
git restore --source=main -- \
  .github/workflows/ \
  scripts/check-custom-platforms.mjs \
  scripts/sync-official-version.mjs \
  UPSTREAM_BOUNDARY.md

git add -A
git commit -m "chore: snapshot official upstream X.Y.Z"
```

> 注意：7 个**钩子文件**此刻先保持官方版，把钩子行的还原留到合并阶段统一处理，避免快照里混入半成品。

### 第 3 步 · 合并进 main 并解决冲突
```bash
git checkout main
git merge --no-ff sync/official-X.Y.Z
```

冲突几乎只落在三类文件（与 1.7.1 完全一致），按边界原则各自处理：

| 冲突文件 | 处理原则 |
|---|---|
| **7 个钩子文件**（`src/content.ts`、`src/core/reader-view.ts`、`src/background.ts`、`src/utils/clip-utils.ts`、`src/utils/reader.ts`、`src/utils/content-extractor.ts`、`src/core/popup.ts`） | **以上游版本为准**；仅在丢失时**重贴那一行 `platformRegistry.*` 钩子调用**，不改上游其它逻辑。 |
| `package.json` / `package-lock.json` | **以上游为准**（依赖、脚本随后续步骤核对）；版本号留到第 6 步戳记。 |
| `src/manifest.*.json`、`README.md`、`reader.scss`、资源/图标 | 以上游为准；README 里自定义章节手动并回。 |

> 钩子要保哪些调用，见 `UPSTREAM_BOUNDARY.md` 第 16–26 行的逐文件清单；`git merge` 输出的 `# Conflicts:` 列表可直接照单处理。

### 第 4 步 · 边界门禁自检（强制）
```bash
npm run check:custom-platforms
```
- **通过** → 7 个平台仍注册、7 个钩子文件的 hook 调用仍在，自定义功能未被合并破坏。
- **失败** → 到对应钩子文件补回那一行 `platformRegistry.*` 调用（最常见也几乎唯一的修复动作）。

### 第 5 步 · 全套校验
```bash
npm run check          # 敏感产物 + 钩子门禁 + tsc + companion tsc + 全部 vitest
npm run build          # chrome + firefox + safari 三端构建
```
自定义平台测试（feishu / wechat / bilibili / douyin / xiaohongshu / x）会在此运行，确认自定义提取未被官方变更影响。

### 第 6 步 · 版本戳记对齐官方
冲突解决、代码就绪后，用脚本统一戳版本（**不要手动改版本号**）：
```bash
npm run sync:official-version      # 写入 package.json/lock + 3 个 manifest 的官方版本号
git add -A && git commit --amend --no-edit   # 或单独提交一次
```

### 第 7 步 · 按 `UPSTREAM_BOUNDARY.md` 的 Sync Checklist 收尾并推送
1. 复查 7 个钩子调用都在；
2. 核心文件保持上游内容，仅在必要时还原钩子行；
3. `check:custom-platforms` ✅；
4. `check`（敏感产物 + 钩子 + 类型 + 测试）✅；
5. 三端构建 ✅；
6. 真实环境**抽测**（对照 `UPSTREAM_BOUNDARY.md` 中 Feishu / X / 小红书 / 抖音各自的 Validation target 链接实测一次）；
7. `git push origin main`。

---

## 四、防回归的三道保险（每次合并自动生效）

- **`check:custom-platforms`**：钩子被合并掉 → 立即失败（防"功能静默消失"）。
- **`npm run check` 内的 vitest**：覆盖全部自定义平台提取逻辑（防"行为被上游改动破坏"）。
- **`git diff --exit-code`（CI 末尾）**：构建不允许产生未跟踪改动，防止构建期意外改动源码。

---

## 五、给维护者的落地建议

1. **严守纪律：自定义只进 `src/platforms/*` + 7 个钩子行。** 这是让上述流程每次都能成立的根本前提。一旦在核心文件里写了自定义逻辑，下次合并冲突会蔓延，`check:custom-platforms` 也救不回来。
2. **上游发布后尽量跟上。** `sync-official-version.yml` 会提醒；拖得越久冲突面越大。
3. **每次合并后跑一次第 7 步的真实抽测。** 单元测试覆盖不到"插件实际在对方站点跑起来"这一层，`UPSTREAM_BOUNDARY.md` 的 Validation 段落正是为此准备的清单。

---

## 六、可选的进一步自动化（后续增强）

把第 2、3 步的 git 命令固化成 `scripts/sync-official.mjs`：自动创建工作分支、用 `git checkout upstream/main -- .` 覆盖、按白名单 `git restore` 保留 fork 特有文件（`.github/workflows/`、`scripts/check-custom-platforms.mjs`、`scripts/sync-official-version.mjs`、`UPSTREAM_BOUNDARY.md`）、提交快照，并在合并后自动重贴 7 个钩子行。
这属于脚本级补充，不触碰任何功能代码，可把"手动挑选保留文件 + 手动补钩子"的人为失误降到最低。
