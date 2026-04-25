# Obsidian Web Clipper（中文内容增强版）

> 本项目基于官方 [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) 改造，保留官方插件的模板、变量、Reader Mode、同步到 Obsidian 等核心能力，并重点增强 **飞书文档** 和 **微信公众号文章** 的内容提取。

[English](./README_EN.md)

## 与官方版本有什么不同？

官方 Obsidian Web Clipper 使用通用网页正文抽取器处理大多数页面。这个机制对普通网页很好用，但在飞书、微信公众号等中文内容平台上经常遇到动态渲染、懒加载、正文容器复杂、媒体链接临时签名等问题，导致内容不完整、图片丢失、视频链接失效，甚至在大量图片文档中导致 Obsidian 打开困难。

本 Fork 的改造重点是：

- 在官方插件基础上增加面向飞书和微信公众号的站点级提取逻辑
- 优先保留官方模板和变量体系，增强后的内容仍然进入原有剪藏流程
- 对大量媒体内容做保护，避免把过多图片直接内联进 Obsidian 导致卡死
- 对无法稳定离线保存的视频，保留更可靠的原文播放入口

### 飞书文档提取增强

官方版本通过通用 DOM 解析提取飞书文档内容，会因飞书的动态渲染机制导致内容不完整。本 Fork 接入 **飞书开放平台 API**，通过结构化接口完整获取文档内容：

- **完整内容** — 获取文档所有块内容，包括文字、标题、列表、代码块、表格、引用等
- **Wiki 支持** — 同时支持飞书知识库（`/wiki/`）和普通文档（`/docx/`）链接
- **结构保留** — 保留文档原有层级结构，转换为标准 HTML，可被 Obsidian Clipper 正常处理
- **媒体保护** — 飞书图片默认不内联下载，只保留可点击链接，避免图片过多时拖慢或卡死 Obsidian
- **手动下载图片** — 需要完整图文时，可在设置中开启“下载图片”；当图片数量较多时会提示风险
- **视频/附件链接兜底** — 对暂时无法稳定内联的视频和附件保留可访问链接，避免生成无效占位

#### 飞书“下载图片”开关如何选择

插件设置中提供了 **飞书 / Lark → 下载图片** 开关，默认关闭。建议客户按以下原则选择：

- **默认关闭**：适合大多数飞书文档，尤其是教程、截图很多的文档。图片会保存为链接，Markdown 本身保持轻量，Obsidian 打开速度更快。
- **手动开启**：只在确实需要完整离线图文副本时开启，例如少量图片的正式归档、需要脱离网络查看图片的笔记。
- **谨慎开启大文档**：飞书图片不像微信公众号图片那样是普通公网图片链接。飞书图片需要通过飞书 API 获取，再写入可访问媒体内容；图片一多，笔记体积和 Obsidian 渲染压力会迅速增加。
- **风险阈值**：约 30 张图片开始可能明显变慢；50 张以上有可能导致 Obsidian 无法打开该笔记。如果出现卡死，请关闭“下载图片”后重新剪藏为图片链接。

微信公众号图片通常保存为 `mmbiz.qpic.cn` 远程图片链接，Obsidian 只是按需加载；飞书图片则需要鉴权获取和转换，因此大量图片时两者表现不同。

**配置方法：**

1. 前往[飞书开放平台](https://open.feishu.cn/app)创建一个自建应用
2. 为应用开通以下权限：`docx:document:readonly`、`wiki:node:read`
3. 获取应用的 App ID 和 App Secret（参见[官方文档：获取访问凭证](https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-access-token#63c75bdc)）
4. 打开 Obsidian Web Clipper 扩展 → 点击右上角 **设置** → **General** → 找到 **飞书 / Lark** 区块，填入 App ID 和 App Secret

> **隐私说明**：App ID 和 App Secret 仅保存在你本地浏览器的存储中（`browser.storage.local`），不会上传到任何服务器。

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

### 为什么没有合并到官方项目？

官方维护者[指出](https://github.com/obsidianmd/obsidian-clipper/pull/1)，针对特定网站的内容提取器应该在 [Defuddle](https://github.com/kepano/defuddle)（内容提取库）中实现，而不是在 Web Clipper 扩展本身。飞书、微信公众号、Bilibili 这些平台的提取需要更多站点级兼容逻辑，本 Fork 独立维护这些改造，方便中文内容用户直接使用。

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
