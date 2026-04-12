# Obsidian Web Clipper（中文内容增强版）

> 基于官方 [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) Fork，专门为中文内容平台增强。

[English](./README_EN.md)

## 与官方版本有什么不同？

本 Fork 在 Reader Mode 中增加了 **Bilibili 视频支持**，体验与官方的 YouTube 集成保持一致：

- **内容提取** — 从 Bilibili 视频页面提取视频简介、章节和字幕
- **视频嵌入** — 在 Reader Mode 中嵌入 Bilibili 播放器，支持置顶固定
- **时间戳点击跳转** — 点击任意字幕或章节的时间戳，视频跳转到对应时间
- **自动滚动** — 播放过程中自动滚动字幕，跟随播放进度
- **高亮当前行** — 播放时高亮显示当前字幕行
- **跨浏览器支持** — 支持 Chrome 和 Firefox，自动处理 `Referer` 请求头

### 为什么没有合并到官方项目？

官方维护者[指出](https://github.com/obsidianmd/obsidian-clipper/pull/1)，针对特定网站的内容提取器应该在 [Defuddle](https://github.com/kepano/defuddle)（内容提取库）中实现，而不是在 Web Clipper 扩展本身。由于将 Bilibili 支持集成到 Defuddle 需要不同的架构方案，本 Fork 独立维护此功能，方便有需要的用户直接使用。

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

## 官方资源

- **[下载官方 Web Clipper](https://obsidian.md/clipper)**
- **[官方文档](https://help.obsidian.md/web-clipper)**
- **[问题排查](https://help.obsidian.md/web-clipper/troubleshoot)**

## 第三方库

- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) — 浏览器兼容
- [defuddle](https://github.com/kepano/defuddle) — 内容提取与 Markdown 转换
- [dayjs](https://github.com/iamkun/dayjs) — 日期解析与格式化
- [lz-string](https://github.com/pieroxy/lz-string) — 模板压缩
- [lucide](https://github.com/lucide-icons/lucide) — 图标
- [dompurify](https://github.com/cure53/DOMPurify) — HTML 净化

## 许可证

MIT — 与[原项目](https://github.com/obsidianmd/obsidian-clipper)一致。
