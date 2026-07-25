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
安装。只有“图片保存方式”或“视频及大附件”至少一项选择本地保存时，才需要
运行配套插件。日常推荐把图片保存为本地二进制附件，同时让视频及大附件
保留飞书链接，以减少 Vault 空间占用。

该插件仅支持 Obsidian Desktop。移动端继续使用普通链接，不启动本机服务。

完整安装、设置组合、迁移和故障处理见
[飞书媒体保存指南](../docs/feishu-media-storage.md)。
