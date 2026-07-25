# Official Sync Boundary

This fork keeps official Obsidian Web Clipper code as close to upstream as practical.
Custom platform behavior should live under `src/platforms`.

## Prefer Not To Edit

- `src/core/*`
- `src/utils/storage-utils.ts`
- `src/utils/shared.ts`
- `src/managers/*`
- `src/background.ts`
- `src/content.ts`
- `src/utils/reader.ts`

## Stable Integration Hooks

These files may contain small, stable platform hook calls:

- `src/content.ts`: `platformRegistry.beforeDomNormalize`, `afterExtract`, `extractStructuredContent`
- `src/core/reader-view.ts`: platform extraction for the standalone Reader page
- `src/background.ts`: `registerPlatformBackgroundHandlers`
- `src/utils/clip-utils.ts`: `platformRegistry.beforeDomNormalize`, `afterExtract`
- `src/utils/reader.ts`: `platformRegistry.extractReaderContent`, `captureReaderState`, `enhanceReader`, `onReaderRestore`
- `src/utils/content-extractor.ts`: `platformRegistry.afterMarkdown`
- `src/managers/general-settings.ts`: platform setting UI bridges

## Custom Platform Area

Put platform-specific behavior here:

- `src/platforms/feishu/*`
- `src/platforms/wechat/*`
- `src/platforms/bilibili/*`
- `src/platforms/douyin/*`
- `src/platforms/github/*`
- `src/platforms/x/*`
- `src/platforms/xiaohongshu/*`

## Platform Lessons To Preserve

### Feishu: image-heavy documents

Do not fix Feishu freezes by reducing image download capability.

The successful behavior is:

- Keep Feishu image downloading in `src/platforms/feishu/*` and `src/utils/feishu-extractor.ts`.
- When "Download images" is enabled, try to inline images as `data:image/...` as fully as practical.
- Do not add small global data URL budgets or low image-count caps; those regress the core use case.
- Videos and attachments should stay as exact fallback links/viewer links, not binary blobs in Markdown.
- If the popup freezes, treat it as a UI rendering problem first: very large `data:image/...` Markdown can make the textarea unresponsive.
- For huge inline-image notes, keep the full Markdown for Add to Obsidian/copy/save, but show a lightweight preview in the popup textarea.
- A time fallback is acceptable for extreme network cases, but it should not become a hidden image-count or total-size limiter.

Validation targets:

- Download images on.
- Feishu document with many images plus videos.
- Add to Obsidian remains clickable.
- Status reflects the full content length and image/media counts.
- Small/medium image documents still inline most or all images.

### X/Twitter: video posts

Do not rely on the page `<video>` URL for X videos.

The correct approach is:

- X video elements often expose only `blob:https://x.com/...`, which is not downloadable outside the current page.
- Keep X-specific logic under `src/platforms/x/*`.
- Use a background platform handler to run `chrome.scripting.executeScript({ world: 'MAIN' })` on the X tab.
- In the page main world, extract the current public X bearer token from the X webpack runtime and use the current browser cookies (`gt`, `ct0`) when available.
- Request X GraphQL `TweetResultByRestId`, then scan `video_info.variants`.
- Prefer the highest bitrate `video/mp4` variant over `m3u8`.
- Append a clear fallback section with `X视频未内联：下载/打开视频` plus the real `https://video.twimg.com/...mp4` URL and poster image.
- Users should not manually provide a token; the browser page already has the runtime token and login/session cookies when the tweet is viewable.

Validation target:

- `https://x.com/oggii_0/status/2048997210428440706`
- Expected video URL pattern: `https://video.twimg.com/ext_tw_video/.../1080x1440/...mp4?...`
- Extracted content contains `X视频未内联` and at least one `video.twimg.com` URL.

### Xiaohongshu: notes with images and videos

Do not rely on Xiaohongshu page `<video>` URLs.

The correct approach is:

- Xiaohongshu video elements often expose only `blob:https://www.xiaohongshu.com/...`, which is not usable after clipping.
- Keep Xiaohongshu-specific logic under `src/platforms/xiaohongshu/*` and parsing helpers in `src/utils/xiaohongshu-extractor.ts`.
- Prefer `window.__INITIAL_STATE__.note.noteDetailMap` for title, author, description, images, tags, and video streams.
- Extract video URLs from both camelCase `media.stream.*.masterUrl` and snake_case `mediaV2.stream.*.master_url` data.
- Use hydrated DOM only as a fallback when the initial state is absent or empty.
- Filter avatar/static UI images so image-only notes do not pick up unrelated page chrome.
- Render Xiaohongshu media as normal block-level document content only: no floating viewer, no extension media page, no overlay. Video should appear before images and should not overlap the image or description blocks.

Validation target:

- `https://www.xiaohongshu.com/explore/6a007a190000000013020402?xsec_token=AB8-jE6vq2aq1dY0Xni2FxuJDDkroJBL71YkNFiuOAXjw=&xsec_source=pc_feed`
- Expected video URL pattern: `http://sns-video-zl.xhscdn.com/stream_glo/...mp4?...`
- Extracted content contains a `<video controls ...>` block before the cover image and does not contain `blob:` video URLs.

### Douyin: video and image posts

Do not rely on Douyin page `<video>` URLs.

The correct approach is:

- Douyin video elements may expose only temporary or page-bound URLs, and short links may need extension-side fetching with current browser cookies.
- Keep Douyin-specific logic under `src/platforms/douyin/*` and parsing helpers in `src/utils/douyin-extractor.ts`.
- Prefer structured script data from `RENDER_DATA`, `window._ROUTER_DATA`, and `window.__UNIVERSAL_DATA_FOR_REHYDRATION__`.
- Recursively find `aweme` objects and choose the exact `aweme_id` from the URL when possible.
- Extract videos from `video.bit_rate[].play_addr`, `video.play_addr`, and `video.download_addr`, preferring the highest bitrate playable URL.
- Extract image posts from `image_post_info.images` / `imagePostInfo.images`, filtering avatars, logos, comments, and other page chrome.
- Render Douyin media as normal block-level document content only: no floating viewer, no extension media page, no overlay. Video should appear before images and should not overlap the image or description blocks.

Validation targets:

- `https://www.douyin.com/video/<aweme_id>`
- `https://www.douyin.com/note/<aweme_id>`
- `https://www.iesdouyin.com/share/video/<aweme_id>/`
- `https://v.douyin.com/<short-code>/`
- Extracted video content should contain a real media URL and should not contain `blob:` video URLs.

## Sync Checklist

After merging an upstream release:

1. Re-check the hook calls listed above.
2. Keep upstream changes in core files unless a platform hook must be restored.
3. Run `npm run check:custom-platforms`.
4. Run `npm run check` for sensitive artifacts, platform hooks, type checking, and the full test suite.
5. Build Chrome, Firefox, and Safari.
