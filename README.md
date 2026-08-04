# Obsidian Web Clipper（中文内容增强版）

> 本项目基于官方 [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) 改造，保留官方插件的模板、变量、Reader Mode、同步到 Obsidian 等核心能力，并重点增强 **飞书文档**、**微信公众号文章**、**Bilibili**、**小红书**、**抖音** 和 **X/Twitter** 的内容提取。

[English](./README_EN.md)

## 与官方版本有什么不同？

官方 Obsidian Web Clipper 使用通用网页正文抽取器处理大多数页面。这个机制对普通网页很好用，但在飞书、微信公众号等中文内容平台上经常遇到动态渲染、懒加载、正文容器复杂、媒体链接临时签名等问题，导致内容不完整、图片丢失、视频链接失效，甚至在大量图片文档中导致 Obsidian 打开困难。

本 Fork 的改造重点是：

- 在官方插件基础上增加面向飞书、微信公众号、Bilibili、小红书、抖音和 X/Twitter 的站点级提取逻辑
- 优先保留官方模板和变量体系，增强后的内容仍然进入原有剪藏流程
- 对大量媒体内容做保护，避免把过多图片直接内联进 Obsidian 导致卡死
- 对无法稳定离线保存的视频，保留更可靠的原文播放入口

### 飞书文档提取增强

官方版本通过通用 DOM 解析提取飞书文档内容，会因飞书的动态渲染机制导致内容不完整。本 Fork 接入 **飞书开放平台 API**，通过结构化接口完整获取文档内容：

- **完整内容** — 获取文档所有块内容，包括文字、标题、列表、代码块、表格、引用等
- **Wiki 支持** — 同时支持飞书知识库（`/wiki/`）和普通文档（`/docx/`）链接
- **复杂对象预览** — 支持直接剪藏 `/sheets/` 电子表格和 `/base/` 多维表格，也会展开文档内嵌的 Sheet/Bitable；大型资源只生成有界只读预览并保留原文入口
- **不再静默丢块** — 任务卡片、OKR、思维笔记及暂未识别的块会显示明确的降级说明和原文链接，而不是从结果中消失
- **结构保留** — 保留文档原有层级结构，转换为标准 HTML，可被 Obsidian Clipper 正常处理
- **媒体策略独立** — 图片与视频/大附件分别选择保存方式，可组合成“图片本地化、视频保留链接”
- **二进制附件流** — 通过 Obsidian 桌面端配套插件把大量图片直接写入 Vault，不再塞入 Base64 Markdown
- **可恢复大媒体下载** — 视频或大附件选择本地保存时，后台任务不依赖弹窗持续打开，并可恢复已完成部分
- **链接兜底** — 不下载的视频和附件保留飞书原文入口，避免生成不可用的临时地址或占用大量磁盘空间

#### 飞书媒体保存方式如何选择

扩展设置的 **General → 飞书 / Lark** 中有两个互不依赖的选项：

| 设置 | 可选方式 | 建议 |
| --- | --- | --- |
| 图片保存方式 | 保留原文链接 / Obsidian 配套插件（二进制附件） / Base64 内联（旧方式） | 图片较多时优先使用配套插件；Base64 仅用于兼容旧流程和少量图片 |
| 视频及大附件 | 保留飞书链接 / 下载到 Obsidian 本地 | 默认保留链接；只有确实需要完整离线归档时才下载 |

常用组合：

- **推荐，大量图片且视频较大**：图片选择“Obsidian 配套插件”，视频及大附件选择“保留飞书链接”。
- **完全离线归档**：两项都选择本地保存。请先确认 Vault 所在磁盘空间充足。
- **轻量剪藏**：两项都保留链接，不安装配套插件也能使用。
- **旧版兼容**：图片选择 Base64，视频及大附件保留链接。大图文文档不建议使用 Base64。

微信公众号图片通常保存为 `mmbiz.qpic.cn` 远程图片链接，Obsidian 只是按需加载；飞书图片则需要鉴权获取和转换，因此大量图片时两者表现不同。

**配置方法：**

1. 前往[飞书开放平台](https://open.feishu.cn/app)创建一个自建应用
2. 为应用开通基础应用身份权限：`docx:document:readonly`、`docs:document.media:download`、`wiki:node:read`
   - 读取电子表格预览：另开通 `sheets:spreadsheet:readonly`
   - 读取多维表格预览：另开通 `bitable:app:readonly`
   - 任务卡片完整详情需要用户 OAuth 和 `task:task:read`，当前版本只保留任务入口，不强制申请该高权限
3. 获取应用的 App ID 和 App Secret（参见[官方文档：获取访问凭证](https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-access-token#63c75bdc)）
4. 打开 Obsidian Web Clipper 扩展 → 点击右上角 **设置** → **General** → 找到 **飞书 / Lark** 区块，填入 App ID 和 App Secret
5. 如需把图片、视频或附件保存到 Vault，安装并启用 `Clipper Attachment Bridge`，填写配套插件地址和配对令牌后点击“测试连接”

> **隐私说明**：App ID 和 App Secret 保存在当前浏览器配置的本地扩展存储中（`browser.storage.local`）。获取租户访问令牌时，凭据只会通过 HTTPS 发送至飞书/Lark 官方认证接口，不会发送至本项目自建服务器。浏览器本地存储不等同于专用密码保险库，请妥善保护浏览器配置和飞书应用权限。

**Obsidian 配套插件安装摘要：**

1. 在本仓库根目录运行 `npm run build:companion`，不要在 `companion-plugin` 子目录运行。
2. 将 `companion-plugin/dist` 内的 `main.js`、`manifest.json`、`styles.css` 复制到 `<当前 Vault>/.obsidian/plugins/clipper-attachment-bridge/`。
3. 三个文件必须直接位于 `clipper-attachment-bridge` 文件夹内，不能多套一层 `dist`。
4. 在 Obsidian **设置 → 第三方插件** 中重新加载插件并启用 `Clipper Attachment Bridge`。它是手动安装插件，不会出现在社区插件商店搜索结果中。
5. 在插件设置中复制配对令牌；回到 Web Clipper 填写 `http://127.0.0.1:27125` 和令牌，点击“测试连接”。

配套插件从源码构建、复制文件、启用、配对和故障处理详见[飞书媒体保存指南](./docs/feishu-media-storage.md)。

### 收藏整个说明文档

扩展支持把当前语言下的整套说明文档一次保存到 Obsidian。发现层按格式工作：支持标准 `llms.txt`（包括 Mintlify 等平台）、sitemap、Sphinx、Docusaurus 和 Google DevSite，因此可覆盖 Kimi、智谱、DeepSeek、Claude、Gemini 等大模型文档，而不是按域名逐个编写下载器。页面清单必须来自站点官方索引，不会无边界递归抓取普通网页链接。

1. 安装并启用桌面端 `Clipper Attachment Bridge` 配套插件（不会出现在社区插件商店）。
2. 在 Web Clipper **设置 → General → 飞书 / Lark** 中填写配套插件地址（通常为 `http://127.0.0.1:27125`）和配对令牌，点击“测试连接”，并确认扩展选择的 Vault 就是 Obsidian 当前打开的 Vault。
3. 打开支持的文档页面，例如 Sphinx 文档或提供 `llms.txt` / sitemap 的主流大模型文档站。
4. 打开 Web Clipper，等待页面提取完成，点击紫色 **Add to Obsidian** 按钮上方单独的 **收藏整个说明文档** 按钮。
5. 确认标题、当前语言、页面数量和保存方式。扩展会读取官方索引，抓取章节并写入选定的 Vault 和文件夹。

按章节模式会生成每页一篇 Markdown，以及 `00 - Documentation index.md`。图片保留官网远程链接；模型卡片、功能卡片等网格会转换为 Obsidian 可渲染的自适应卡片块。相对链接会转换为完整官网地址，`llms.txt` 的重复索引提示和空的标准元数据会被清理。新版 Companion 会分批写入并保存断点，且只有全部页面和索引均已落盘后才标记完成；中断后再次执行只继续未完成页面。重复收藏时只覆盖该文档集合先前生成的笔记，不覆盖用户新建的其他笔记，也不会自动删除官网已下线的旧页面。

文档不超过 100 页时，如果 Companion 不可用、未配对、连接到其他 Vault 或版本过旧，确认框会显示“合并为一篇 Markdown”模式。超过 100 页必须连接支持可恢复文档集合的新版 Companion，并按文件夹和多篇笔记保存。

如果看不到“收藏整个说明文档”按钮，请刷新当前文档页面并重新打开扩展；PDF、浏览器内部页面和没有受支持官方索引的普通网页不支持此功能。

### 微信公众号文章提取增强

微信公众号文章大量使用懒加载和特殊媒体容器。官方通用提取器在部分文章中可能只保留第一张图片，或者把图片占位符清掉，导致 Obsidian 中没有图片。本 Fork 增加了专门的微信公众号处理逻辑：

- **图片懒加载修正** — 自动读取 `data-src` 中的真实图片地址，写回标准 `src`
- **正文容器回退** — 当通用正文抽取器丢失图片时，回退使用公众号正文容器 `#js_content`
- **无效占位过滤** — 过滤 1px 占位图、空头像、无效 `src`，避免生成坏图片
- **保留原文结构** — 保留标题、段落、代码块、图片等正文内容，使其能正常转换为 Markdown
- **视频处理说明** — 微信公众号视频的 `mpvideo.qpic.cn` 直链通常是临时签名地址，下载后容易失效或无法播放。本 Fork 不把它当作永久 mp4 保存，而是保存视频封面和原文播放入口。

### Bilibili 视频支持

在 Reader Mode 中增加了 **Bilibili 视频支持**，体验与官方的 YouTube 集成保持一致：

- **内容提取** — 从 Bilibili 视频页面提取视频简介、章节和字幕
- **视频嵌入** — 在 Reader Mode 中嵌入 Bilibili 播放器，支持置顶固定
- **时间戳点击跳转** — 点击任意字幕或章节的时间戳，视频跳转到对应时间
- **自动滚动** — 播放过程中自动滚动字幕，跟随播放进度
- **高亮当前行** — 播放时高亮显示当前字幕行
- **跨浏览器支持** — 支持 Chrome 和 Firefox，自动处理 `Referer` 请求头

### 小红书笔记支持

小红书页面的视频元素经常只暴露 `blob:` 播放地址，直接保存会在 Obsidian 中失效。本 Fork 增加了小红书笔记的专用提取逻辑：

- **笔记识别** — 支持 `xiaohongshu.com/explore/...`、`xiaohongshu.com/discovery/item/...` 和 `xhslink.com` 链接
- **正文与标签** — 提取标题、作者、正文、话题标签和原文链接
- **图片保存** — 从小红书结构化数据或已渲染页面中提取真实图片地址，过滤头像和静态占位图
- **视频保存** — 优先从 `window.__INITIAL_STATE__` 中提取真实 `xhscdn.com` MP4 地址，避免保存不可复用的 `blob:` 地址
- **普通文档流显示** — 视频和图片按独立块级内容写入笔记，不使用悬浮层或中转查看页；视频在前、图片在后，避免错位重叠

### 抖音作品支持

抖音视频和图文页面也会使用动态渲染、短链跳转和临时媒体地址。本 Fork 增加了抖音作品的专用提取逻辑：

- **作品识别** — 支持 `douyin.com/video/...`、`douyin.com/note/...`、`iesdouyin.com/share/video/...`、`iesdouyin.com/share/note/...` 和 `v.douyin.com` 短链
- **结构化数据优先** — 优先扫描 `RENDER_DATA`、`_ROUTER_DATA`、`__UNIVERSAL_DATA_FOR_REHYDRATION__` 中的 `aweme` 数据
- **视频保存** — 从 `video.play_addr`、`video.bit_rate[].play_addr` 等字段提取真实播放地址，避免保存不可复用的 `blob:` 地址
- **图文保存** — 从 `image_post_info.images` 中提取图文作品图片，过滤头像、logo、评论表情等页面装饰图
- **文案保留** — 保存作者、文案、发布时间、原文链接，并提供 `douyinAwemeId`、`douyinVideo`、`douyinImages` 等模板变量
- **普通文档流显示** — 视频、图片和文案都作为普通块级内容写入 Obsidian，不使用悬浮层或中转查看页

### X/Twitter 支持

X/Twitter 的视频也经常只在页面 DOM 中暴露 `blob:` 地址。本 Fork 保留了专门的 X 平台逻辑：

- **推文识别** — 支持 `x.com/.../status/...` 和 `twitter.com/.../status/...`
- **长文与线程** — 尽量展开正文并保留同作者线程内容
- **图片顺序** — 保留推文正文附近的图片和媒体链接，减少图片错位或遗漏
- **视频兜底** — 通过页面主环境和 X GraphQL 数据提取 `video.twimg.com` MP4 地址，生成可点击/可播放的视频段落
- **无需手动 Token** — 使用当前浏览器页面已有的运行时信息和登录状态，不要求用户单独提供 X Token

### 为什么没有合并到官方项目？

官方维护者[指出](https://github.com/obsidianmd/obsidian-clipper/pull/1)，针对特定网站的内容提取器应该在 [Defuddle](https://github.com/kepano/defuddle)（内容提取库）中实现，而不是在 Web Clipper 扩展本身。飞书、微信公众号、Bilibili、小红书、抖音和 X/Twitter 这些平台的提取需要更多站点级兼容逻辑，本 Fork 独立维护这些改造，方便中文内容用户直接使用。

### 如何跟随官方升级？

本项目把自定义站点逻辑集中在 `src/platforms/*`，核心流程只保留少量平台钩子，便于后续合并官方 `obsidianmd/obsidian-clipper` 的更新。具体同步步骤和冲突处理原则见 [Upstream Sync Guide](./docs/upstream-sync.md)，每次升级后的重点验证网址见 [Manual Regression Checklist](./docs/manual-regression-checklist.md)。

## 快速开始

### 从源码构建

```bash
npm install
npm run build
```

构建产物：
- `dist/` — Chromium 版本
- `dist_firefox/` — Firefox 版本
- `dist_safari/` — Safari 版本

### 本地安装扩展

**Chromium 浏览器**（Chrome、Brave、Edge、Arc）：

1. 打开浏览器访问 `chrome://extensions`
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择 `dist` 目录

**Firefox**：

1. 打开 Firefox 访问 `about:debugging#/runtime/this-firefox`
2. 点击 **临时载入附加组件**
3. 进入 `dist_firefox` 目录，选择 `manifest.json` 文件

如需在 Firefox 中永久安装，可使用 Nightly 或 Developer 版本：

1. 地址栏输入 `about:config`
2. 搜索 `xpinstall.signatures.required`
3. 双击将其设为 `false`
4. 前往 `about:addons` > 齿轮图标 > **从文件安装附加组件…**

## 许可证

MIT — 与[原项目](https://github.com/obsidianmd/obsidian-clipper)一致。
