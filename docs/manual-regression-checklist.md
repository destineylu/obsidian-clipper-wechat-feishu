# Manual regression checklist

Run this checklist after syncing from the official Obsidian Web Clipper or changing the Feishu/WeChat extraction layer.

## WeChat Official Account articles

1. Open `https://mp.weixin.qq.com/s/IeONqjYB_OiZnrm8g2nHqw`.
   - The popup status should report many images.
   - Images should appear as Markdown image links, not broken SVG placeholders.
2. Open `https://mp.weixin.qq.com/s/2iSbCfpJYoVESy7jNV63Hw`.
   - Body text and images should be preserved.
3. Open `https://mp.weixin.qq.com/s/-pu82htKXMUN9Kbcerfk3Q`.
   - Body text and images should be preserved.
4. Open `https://mp.weixin.qq.com/s/vdRCUqg0Q0wTXvCCv0KfgQ`.
   - The popup status should show the full extraction count, not only the first two visible lines.
   - The note content should include `注册 Google Cloud` and 33 image links.

## Feishu documents

1. Open `https://ycnezwebj31p.feishu.cn/docx/RZ5rdcwcsoHBuexfSwrcPdkbnjc`.
   - With "Download images" enabled, extracted content should include Feishu image placeholders or inlined images without freezing the popup.
   - With "Download images" disabled, image/video/file media should become clean links.
2. Open `https://my.feishu.cn/docx/VvuWd0hNPoQAASxHY2pcY3qNnsf`.
   - Confirm the large-image warning appears when image count is high.
   - Confirm Obsidian can still open the saved note when images are not downloaded.
3. Open `https://ycnezwebj31p.feishu.cn/docx/Xp6fdTJOfowcLTxOnf2crvgUnub`.
   - Video attachments should be represented as clean "Feishu video not inlined" links.
   - Internal media tokens should not be repeated after the link text.

## Build checks

Run:

```bash
npm run check:custom-platforms
OFFICIAL_CLIPPER_VERSION=1.6.1 npm run build:chrome
```

