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

安装并启用配套插件后，在浏览器打开 Sphinx 说明文档（例如
`https://docs.datasette.io/en/stable/`），打开 Web Clipper，点击紫色
**Add to Obsidian** 按钮右侧的 **▼**，再选择 **Clip entire documentation**。

确认页面数和保存方式后，插件会按章节写入当前 Vault，并生成
`00 - Documentation index.md`。索引会保留网站左侧目录的嵌套关系：子页面进入父页面文件夹，目录分组也会保留；无法从侧边栏读取层级时，会回退到 Sphinx 的页面路径。再次执行会覆盖相同路径的笔记，不会删除 Vault 中的其他笔记。

如果没有运行或没有正确配对本插件，扩展仍会工作，但会降级为一篇合并的 Markdown 笔记。若菜单中没有该功能，请确认当前页面是 Sphinx 文档、已刷新页面，并重新打开扩展。

完整安装、设置组合、迁移和故障处理见
[飞书媒体保存指南](../docs/feishu-media-storage.md)。
