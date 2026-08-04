# Clipper Attachment Bridge

Obsidian 桌面端配套插件。它仅在 `127.0.0.1` 上接收 Web Clipper
发送的二进制附件，并通过官方 Vault API 写入当前 Vault。

## 构建

```powershell
npm run build:companion
```

将 `companion-plugin/dist` 内的 `main.js`、`manifest.json` 和 `styles.css`
复制到当前 Vault 的 `.obsidian/plugins/clipper-attachment-bridge`。三个文件
必须直接位于该文件夹内，不能多套一层 `dist`。在 Obsidian 设置中重新加载
第三方插件并启用 `Clipper Attachment Bridge`。
首次启用后，从插件设置复制一次性显示的配对令牌，并粘贴到浏览器扩展的
飞书附件桥接设置中。

该插件不会出现在 Obsidian 社区插件商店的搜索结果中，必须按上述目录手动
安装。飞书附件本地保存或“收藏整个说明文档”的分章节模式需要运行配套插件；
未连接配套插件时，整套说明文档会安全降级为一篇合并笔记。日常推荐把飞书
图片保存为本地二进制附件，同时让视频及大附件保留飞书链接，以减少 Vault
空间占用。

该插件仅支持 Obsidian Desktop。移动端继续使用普通链接，不启动本机服务。

## 收藏整个说明文档

安装并启用配套插件后，在浏览器打开受支持的 Sphinx、Docusaurus、Claude Platform 或 Gemini API 说明文档，打开 Web Clipper，点击紫色
**Add to Obsidian** 按钮上方单独的 **收藏整个说明文档** 按钮。

确认页面数和保存方式后，插件会按章节写入当前 Vault，并生成
`00 - Documentation index.md`。新版协议按最多 50 篇或 10 MiB 分批写入，并在插件私有目录保存断点和笔记归属；只有全部页面和索引都已保存时才会标记完成。中断后再次执行会继续未完成页面；重复同步只覆盖同一文档集合生成的笔记，用户笔记与官网已下线的旧页面都会保留。文档图片保持远程链接，网页卡片会转换为 Obsidian 可渲染的自适应卡片块。

如果文档不超过 100 页且没有正确连接本插件，扩展会降级为一篇合并的 Markdown 笔记；超过 100 页必须连接新版插件。若按钮没有显示，请确认页面属于受支持的文档站点、刷新页面并重新打开扩展。

完整安装、设置组合、迁移和故障处理见
[飞书媒体保存指南](../docs/feishu-media-storage.md)。
