# 飞书媒体保存与配套插件安装指南

本文说明 Obsidian Web Clipper 中文增强版如何处理飞书/Lark 文档中的图片、视频和大附件，并给出 `Clipper Attachment Bridge` 的完整手动安装步骤。

## 保存策略

进入浏览器扩展的 **设置 → General → 飞书 / Lark**。媒体设置已经拆分为两个独立选项。

### 图片保存方式

| 选项 | 行为 | 适用场景 |
| --- | --- | --- |
| 保留原文链接 | 不下载图片，笔记中保留可点击入口 | 轻量剪藏、无需离线图片 |
| Obsidian 配套插件（二进制附件） | 将图片作为普通附件写入当前 Vault | 图片较多、需要离线查看 |
| Base64 内联（旧方式） | 将图片数据写进 Markdown | 兼容旧流程，仅建议少量图片 |

### 视频及大附件

| 选项 | 行为 | 适用场景 |
| --- | --- | --- |
| 保留飞书链接（推荐） | 不下载视频和大文件，保留飞书原文入口 | 节省空间，日常剪藏 |
| 下载到 Obsidian 本地 | 通过配套插件保存到 Vault | 完整离线归档 |

两项可以任意组合。多数用户推荐：

```text
图片保存方式：Obsidian 配套插件（二进制附件）
视频及大附件：保留飞书链接（推荐）
```

这种组合既能解决大量图片的 Base64 内存和笔记体积问题，又不会让大型视频占满 Vault。

## 飞书开放平台设置

1. 在[飞书开放平台](https://open.feishu.cn/app)创建自建应用。
2. 为应用开通以下**应用身份**权限：
   - `docx:document:readonly`
   - `docs:document.media:download`
   - `wiki:node:read`
3. 创建并发布包含这些权限的应用版本。
4. 在 Web Clipper 的 **设置 → General → 飞书 / Lark** 中填写 App ID 和 App Secret。

App Secret 只会发送给飞书/Lark 官方认证接口以获取租户令牌，不会发送给本项目的 Obsidian 配套插件。

## 安装 Obsidian 配套插件

### 重要说明

`Clipper Attachment Bridge` 目前是本仓库提供的手动安装插件，**不会出现在 Obsidian 社区插件商店的搜索结果中**。必须从源码构建并复制到当前 Vault 的 `.obsidian/plugins` 目录。

配套插件只支持 Obsidian Desktop。只使用“保留原文链接”时不需要安装它。

### 第一步：在仓库根目录构建

PowerShell 进入本仓库根目录，而不是进入 `companion-plugin` 子目录。将下面的
`<仓库根目录>` 替换为实际克隆路径：

```powershell
Set-Location '<仓库根目录>\obsidian-clipper-cn'
npm install
npm run build:companion
```

构建成功后应存在：

```text
<仓库根目录>\obsidian-clipper-cn\companion-plugin\dist\
├── main.js
├── manifest.json
└── styles.css
```

构建还可能生成可选的 `main.js.map` 调试文件；Obsidian 运行插件只需要上面
列出的三个文件。

### 第二步：确认当前 Vault 根目录

Vault 是 Obsidian 当前打开的知识库根目录，不是 `Clippings` 等笔记保存文件夹。例如：

```text
C:\Users\<用户名>\Documents\Obsidian Vault
```

如果 Web Clipper 的目标文件夹填写 `Clippings`，最终笔记会写入：

```text
<Vault>\Clippings\
```

但配套插件仍然必须安装到 Vault 根目录下的 `.obsidian/plugins`，不能安装到 `Clippings`。

### 第三步：复制三个构建文件

在当前 Vault 中创建以下目录：

```text
<Vault>\.obsidian\plugins\clipper-attachment-bridge\
```

把 `companion-plugin\dist` **里面的三个文件**复制进去。正确结构必须是：

```text
<Vault>\.obsidian\plugins\clipper-attachment-bridge\
├── main.js
├── manifest.json
└── styles.css
```

不要多套一层 `dist`。以下结构是错误的：

```text
<Vault>\.obsidian\plugins\clipper-attachment-bridge\dist\main.js
```

Windows 资源管理器默认可能隐藏以点开头的 `.obsidian` 目录，请开启“查看 → 显示 → 隐藏的项目”。

也可以在仓库根目录使用 PowerShell 复制。先把 `$vaultRoot` 改成当前 Vault
的实际根目录：

```powershell
$vaultRoot = 'C:\路径\到\当前 Vault'
$pluginTarget = Join-Path $vaultRoot '.obsidian\plugins\clipper-attachment-bridge'

New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
Copy-Item -LiteralPath '.\companion-plugin\dist\main.js' -Destination $pluginTarget -Force
Copy-Item -LiteralPath '.\companion-plugin\dist\manifest.json' -Destination $pluginTarget -Force
Copy-Item -LiteralPath '.\companion-plugin\dist\styles.css' -Destination $pluginTarget -Force

Get-ChildItem -LiteralPath $pluginTarget
```

最后一条命令应直接列出 `main.js`、`manifest.json` 和 `styles.css`。

### 第四步：让 Obsidian 识别插件

1. 打开 Obsidian **设置 → 第三方插件**。
2. 如果安全模式仍开启，先允许第三方插件。
3. 点击第三方插件列表旁的“重新加载插件”按钮；如果没有该按钮，完全退出并重新启动 Obsidian。
4. 在“已安装插件”中找到 `Clipper Attachment Bridge` 并启用。

如果仍找不到，依次检查：

- 复制的是当前打开 Vault 的 `.obsidian/plugins`，不是另一个 Vault；
- 文件夹名称是 `clipper-attachment-bridge`；
- `manifest.json` 与 `main.js` 直接位于该文件夹内；
- 没有复制成 `clipper-attachment-bridge/dist/main.js`；
- Obsidian 已重新加载第三方插件。

### 第五步：配对浏览器扩展

1. 打开 Obsidian **设置 → Clipper Attachment Bridge**。
2. 确认服务已启动，并复制插件显示的“新配对令牌”；如果令牌已经不再显示，点击“重新生成”并使用新令牌，旧令牌会立即失效。
3. 打开 Web Clipper **设置 → General → 飞书 / Lark**。
4. 至少把一个媒体选项设为 Obsidian 本地保存。
5. 填写：

```text
配套插件地址：http://127.0.0.1:27125
配对令牌：粘贴 Obsidian 配套插件中的令牌
```

6. 点击“测试连接”。
7. 页面应显示“连接成功”，并显示当前 Vault 名称。

若在 Obsidian 插件设置中修改了端口，浏览器扩展中的地址也必须使用相同端口。

### 第六步：确认 Vault 一致

Web Clipper 选择的 Vault 名称必须与 Obsidian 当前打开的 Vault 一致。`Clippings` 是目标文件夹，不是 Vault 名称。

例如：

```text
当前 Obsidian Vault：Obsidian Vault
Web Clipper 选择的 Vault：Obsidian Vault
目标文件夹：Clippings
```

这种配置是正确的。

## 下载与恢复行为

- 图片以二进制附件写入 Vault，不会转换为 Base64。
- 选择本地保存的视频和大附件使用可恢复会话；关闭 Web Clipper 弹窗不会取消配套插件已经接管的下载。
- 重新打开同一飞书文档后，扩展会读取已有进度，只重试未完成项目。
- 最终笔记只会在所有必需的本地附件达到完成状态后提交。
- 选择“保留飞书链接”的视频和附件不会进入下载队列，也不会占用 Vault 空间。
- 每日笔记追加/前置等不能安全使用桥接保存的流程会退回飞书原文链接，不会留下 `feishu-bridge://` 标记。

## 旧配置迁移

- 旧版本已经选择“Obsidian 配套插件”的用户，升级后会保持原来的“图片、视频和附件全部本地保存”行为。
- 新安装默认将视频及大附件设为“保留飞书链接”。
- 如需采用新的推荐组合，升级后手动把“视频及大附件”改成“保留飞书链接”即可。
- 迁移不会修改配套插件地址、配对令牌或图片保存方式。

## 常见问题

### 测试连接失败

确认：

- Obsidian Desktop 正在运行；
- `Clipper Attachment Bridge` 已启用；
- 地址、端口和配对令牌一致；
- 没有把地址误填成其他插件的端口；
- 本机安全软件没有拦截回环连接。

### 提示 Vault 不一致

Web Clipper 的保存目标是 Vault 名称，不是 `Clippings` 等文件夹名称。请让当前打开的 Obsidian Vault 与扩展选择的 Vault 一致；目标文件夹可以继续使用 `Clippings`。

### 某个附件失败

保持原飞书文档可访问并再次点击“添加到 Obsidian”。可恢复会话会保留已经完成的附件，只重新处理失败或未完成部分。若飞书拒绝下载，请检查应用身份的 `docs:document.media:download` 权限及其已发布版本。

### Vault 占用空间过大

把“视频及大附件”改为“保留飞书链接”。图片仍可继续使用本地二进制附件，两项互不影响。

## 安全边界

- App ID 和 App Secret 保存在浏览器扩展本地存储，只用于调用飞书/Lark 官方认证接口。
- 对选择本地保存的媒体，扩展可能通过经过配对令牌保护的 `127.0.0.1` 连接，把短期下载 URL 和临时租户访问令牌交给配套插件完成流式下载。
- 临时下载 URL、授权头、租户令牌和完整飞书文档标识只在下载期间保存在内存中，不写入可恢复会话元数据、最终笔记或日志。
- 配套插件只向经过允许列表校验的飞书/Lark 官方 API 或媒体域名发送下载请求，并在每次跳转时重新校验目标。

## 开发验证

```powershell
npm run check
npm run build:chrome
npm run build:companion
git diff --check
```

人工回归步骤见 [Manual Regression Checklist](./manual-regression-checklist.md)。
