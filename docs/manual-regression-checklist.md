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

1. Open `https://<tenant>.feishu.cn/docx/<public-test-document-1>`.
   - Set image storage to **Obsidian companion** and videos/large files to **Keep Feishu links**.
   - Images should become local Vault embeds after saving.
   - Videos and file attachments should remain clean source-document links and must not enter the bridge progress count.
2. Open `https://<tenant>.feishu.cn/docx/<public-test-document-2>`.
   - Set image storage to **Keep original links** and videos/large files to **Download to Obsidian**.
   - Image placeholders should become clean fallback links.
   - Videos and file attachments should become typed bridge assets and local Vault embeds.
3. Open `https://<tenant>.feishu.cn/docx/<public-test-document-3>`.
   - Select local storage for both controls.
   - Closing and reopening the popup should preserve completed progress.
   - Retrying should process only failed or incomplete assets.
   - The final note should contain no Base64 media or `feishu-bridge://` markers.
4. Simulate a slow or oversized image response.
   - The request should be aborted at the per-request deadline or byte limit.
   - Reaching the document-wide time/byte budget should leave portable fallback links and no active background downloads.
5. Verify settings and migration.
   - Companion endpoint/token settings should be visible when either media control uses the companion.
   - They should be hidden when neither control uses the companion.
   - A legacy companion configuration with no attachment setting should migrate to all-local behavior.
   - A new configuration should default videos and large files to links.
6. Save through a daily-note append or prepend behavior.
   - Every image, video, and file bridge marker should fall back to a source-document link.

## Bilibili Reader

1. Open Reader Mode for two Bilibili videos in separate tabs.
   - Both embedded players should continue loading.
2. Close or restore one Reader tab.
   - The other Bilibili player must continue loading.
   - YouTube Reader/API requests must remain unaffected.
3. Verify playback tracking accepts messages only from the current `player.bilibili.com` iframe.

## Build checks

Run:

```powershell
npm run check
npm run build
npm audit --omit=dev --audit-level=low
```
