# Obsidian Web Clipper (Chinese Content Enhanced)

> This project is built on top of the official [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper). It keeps the official template, variable, Reader Mode, and Obsidian capture workflow, while focusing its custom work on better extraction for **Feishu/Lark documents**, **WeChat Official Account articles**, **Bilibili**, **Xiaohongshu**, **Douyin**, and **X/Twitter**.

[中文说明](./README.md)

## What's different from the official version?

The official Obsidian Web Clipper uses a generic article extractor for most pages. That works well for ordinary websites, but Chinese content platforms such as Feishu/Lark and WeChat Official Accounts often rely on dynamic rendering, lazy-loaded images, complex article containers, and temporary signed media URLs. The result can be incomplete content, missing images, broken video links, or Obsidian notes that become slow to open when too many images are embedded.

This fork focuses on:

- Adding site-specific extraction on top of the official extension for Feishu/Lark, WeChat, Bilibili, Xiaohongshu, Douyin, and X/Twitter
- Preserving the official template and variable pipeline
- Protecting Obsidian from very large media-heavy notes
- Keeping a reliable original-page playback entry for videos that cannot be saved as stable standalone files

### Feishu/Lark document extraction

The official version extracts Feishu document content via generic DOM parsing, which often returns incomplete results due to Feishu's dynamic rendering. This fork integrates the **Feishu Open Platform API** to fetch document content through structured endpoints:

- **Complete content** — Retrieves all document blocks including text, headings, lists, code blocks, tables, quotes, and more
- **Wiki support** — Works with both Feishu Wiki (`/wiki/`) and regular document (`/docx/`) URLs
- **Structure preserved** — Maintains the original document hierarchy, converted to standard HTML for Obsidian Clipper to process
- **Independent media policies** — Image storage and video/large-file storage are configured separately
- **Binary Vault attachments** — A Desktop companion writes large image sets to the Vault without Base64 Markdown
- **Resumable large-media downloads** — Local videos and files can continue without keeping the popup open
- **Portable link fallback** — Media that is not downloaded keeps an original Feishu document entry instead of an unusable temporary URL

#### How to choose Feishu media storage

Open **Settings → General → Feishu / Lark** and configure the two independent controls:

| Setting | Options | Recommendation |
| --- | --- | --- |
| Image storage | Original links / Obsidian companion / Legacy Base64 | Use the companion for image-heavy documents; use Base64 only for small legacy workflows |
| Videos and large files | Keep Feishu links / Download to Obsidian | Keep links by default; download only for a deliberate offline archive |

Recommended combinations:

- **Image-heavy document with large videos**: local companion images plus linked videos/files.
- **Complete offline archive**: local companion storage for both controls; check disk capacity first.
- **Lightweight clipping**: keep both controls as links; the companion is not required.
- **Legacy compatibility**: Base64 images plus linked videos/files.

WeChat Official Account images are usually saved as remote `mmbiz.qpic.cn` links and loaded on demand by Obsidian. Feishu images require authenticated fetching and conversion, so large image-heavy documents behave differently.

**Setup:**

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and create a custom app
2. Grant the app these application-identity permissions: `docx:document:readonly`, `docs:document.media:download`, `wiki:node:read`
3. Get the App ID and App Secret (see [official docs: Get access token](https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-access-token#63c75bdc))
4. Open Obsidian Web Clipper → click **Settings** (top-right) → **General** → find the **Feishu / Lark** section → enter your App ID and App Secret
5. To save binary media into a Vault, install and enable `Clipper Attachment Bridge`, enter its endpoint and pairing token, and run **Test connection**

> **Privacy note**: App ID and App Secret are stored in local extension storage (`browser.storage.local`). They are sent over HTTPS only to the official Feishu/Lark authentication API to obtain a tenant token, and are not sent to a server operated by this project.

**Companion installation summary:**

1. Run `npm run build:companion` from the repository root, not from the `companion-plugin` subdirectory.
2. Copy `main.js`, `manifest.json`, and `styles.css` from `companion-plugin/dist` directly into `<active-vault>/.obsidian/plugins/clipper-attachment-bridge/`.
3. Reload third-party plugins in Obsidian and enable `Clipper Attachment Bridge`. It is manually installed and is not listed in the Community Plugins store.
4. Copy its pairing token, enter `http://127.0.0.1:27125` and the token in Web Clipper, then run **Test connection**.

See the [Feishu media storage guide](./docs/feishu-media-storage.md) for complete companion installation, migration behavior, and troubleshooting.

### Capture an entire documentation site

The extension can save a complete Sphinx documentation site, including its
chapter pages and navigation hierarchy. This is separate from normal single-page
clipping.

#### Chapter-by-chapter mode (recommended)

1. Install and enable the desktop `Clipper Attachment Bridge` companion plugin.
   It is not listed in Obsidian Community Plugins; follow the installation steps
   above or the [complete guide](./docs/feishu-media-storage.md).
2. In Web Clipper **Settings → General → Feishu / Lark**, enter the bridge
   endpoint (normally `http://127.0.0.1:27125`) and pairing token, then click
   **Test connection**. The selected Vault must be the Vault currently open in
   Obsidian.
3. Open any page under the Sphinx documentation site, such as
   `https://docs.datasette.io/en/stable/`.
4. Open Web Clipper and wait for extraction to finish. On a recognized Sphinx
   page, click the separate **收藏整个说明文档** button immediately above the
   purple **Add to Obsidian** button.
5. Confirm the detected title, page count and output mode. The extension then
   discovers the Sphinx search index, fetches the chapter pages, and writes the
   notes to the selected Vault and folder.

The companion mode creates one Markdown note per page plus
`00 - Documentation index.md`. The index follows the site's navigation when it
can be read: nested sidebar entries become nested Wiki links, child pages are
written into parent folders, and caption/group entries are retained as folder
headings. Pages not present in the sidebar are grouped under `Other pages`; if
the sidebar cannot be parsed, Sphinx `docname` paths provide the fallback
hierarchy. Re-running the same collection overwrites notes with the same paths,
but never deletes unrelated notes.

#### Merged-note mode (without the companion plugin)

If the bridge is unavailable, unpaired, connected to another Vault, or too old
to support document bundles, the confirmation dialog explicitly reports the
fallback **one merged Markdown note** mode. The entire site is saved as one
note in navigation order. Page titles become heading levels, and in-page
headings are nested underneath their page title without duplicating it.

#### If the button is missing

The action is shown only when the current page looks like Sphinx documentation.
Refresh the page and reopen Web Clipper, then check that the URL is an ordinary
`http://` or `https://` page rather than a PDF viewer or browser-internal page.
The collector accepts only pages on the same origin and within the detected
documentation root, and currently supports up to 100 source pages.

### WeChat Official Account article extraction

WeChat Official Account articles rely heavily on lazy-loaded images and custom media containers. The official generic extractor can keep only the first image on some posts, or remove image placeholders entirely. This fork adds WeChat-specific handling:

- **Lazy image normalization** — Reads the real image URL from `data-src` and writes it back to standard `src`
- **Article container fallback** — Falls back to the WeChat article body `#js_content` when the generic extractor drops images
- **Invalid placeholder filtering** — Removes 1px placeholders, empty avatar images, and invalid `src` values
- **Article structure preservation** — Keeps paragraphs, code blocks, images, and headings suitable for Markdown conversion
- **Video handling note** — WeChat `mpvideo.qpic.cn` URLs are temporary signed playback URLs and often fail after download. This fork saves a video cover and an original-article playback link instead of treating those URLs as permanent mp4 files.

### Bilibili video support

Adds **Bilibili video support** in Reader Mode, bringing the same experience as the official YouTube integration:

- **Content extraction** — Extracts video description, chapters, and subtitles/transcript from Bilibili pages
- **Video embed** — Embeds Bilibili player in Reader Mode with sticky pin-player support
- **Clickable timestamps** — Click any subtitle or chapter timestamp to seek the video
- **Auto-scroll** — Automatically scrolls the transcript to follow playback
- **Highlight active line** — Highlights the current subtitle line during playback
- **Cross-browser support** — Works on Chrome and Firefox with proper `Referer` header handling

### Xiaohongshu note support

Xiaohongshu video elements often expose only `blob:` playback URLs, which cannot be reused after clipping. This fork adds a dedicated Xiaohongshu extractor:

- **Note URL support** — Supports `xiaohongshu.com/explore/...`, `xiaohongshu.com/discovery/item/...`, and `xhslink.com`
- **Text and tags** — Extracts title, author, description, topic tags, and original URL
- **Image extraction** — Reads real image URLs from structured state or the hydrated page while filtering avatars and static UI placeholders
- **Video extraction** — Prefers real `xhscdn.com` MP4 URLs from `window.__INITIAL_STATE__` instead of unusable `blob:` URLs
- **Normal document flow** — Writes videos and images as standalone block-level note content, without floating viewers, extension media pages, or overlays; videos are placed before images to avoid layout overlap

### Douyin post support

Douyin video and image posts rely on dynamic rendering, short links, and temporary media URLs. This fork adds a dedicated Douyin extractor:

- **Post URL support** — Supports `douyin.com/video/...`, `douyin.com/note/...`, `iesdouyin.com/share/video/...`, `iesdouyin.com/share/note/...`, and `v.douyin.com` short links
- **Structured state first** — Scans `RENDER_DATA`, `_ROUTER_DATA`, and `__UNIVERSAL_DATA_FOR_REHYDRATION__` for `aweme` data
- **Video extraction** — Reads real playback URLs from `video.play_addr`, `video.bit_rate[].play_addr`, and related fields instead of saving unusable `blob:` URLs
- **Image post extraction** — Reads image posts from `image_post_info.images` while filtering avatars, logos, comment emojis, and other page chrome
- **Caption preservation** — Saves author, caption, publish time, original URL, and template variables such as `douyinAwemeId`, `douyinVideo`, and `douyinImages`
- **Normal document flow** — Writes videos, images, and captions as regular block-level Obsidian note content without floating viewers or extension media pages

### X/Twitter support

X/Twitter videos also commonly expose only `blob:` URLs in the DOM. This fork keeps dedicated X platform logic:

- **Status URL support** — Supports `x.com/.../status/...` and `twitter.com/.../status/...`
- **Long posts and threads** — Expands text when possible and preserves same-author thread content
- **Media order** — Keeps images and media links near the tweet body to reduce missing or misplaced media
- **Video fallback** — Uses the page main world and X GraphQL data to find `video.twimg.com` MP4 URLs and emits playable/clickable video sections
- **No manual token setup** — Reuses the current browser page runtime and login/session state when the tweet is viewable

### Why not merged upstream?

The official maintainer [indicated](https://github.com/obsidianmd/obsidian-clipper/pull/1) that site-specific content extractors should be implemented in [Defuddle](https://github.com/kepano/defuddle) (the content extraction library), not in the Web Clipper extension itself. Feishu/Lark, WeChat, Bilibili, Xiaohongshu, Douyin, and X/Twitter require more site-specific compatibility logic, so this fork maintains those changes independently for Chinese content users who need them now.

### How to follow official updates?

This fork keeps custom platform behavior under `src/platforms/*`, while the official-like core flow only keeps small platform hooks. This makes future merges from `obsidianmd/obsidian-clipper` easier to review. See [Upstream Sync Guide](./docs/upstream-sync.md) for the workflow and conflict rules, and [Manual Regression Checklist](./docs/manual-regression-checklist.md) for the URLs to verify after each upgrade.

## Get started

### Build from source

```bash
npm install
npm run build
```

Build outputs:
- `dist/` — Chromium version
- `dist_firefox/` — Firefox version
- `dist_safari/` — Safari version

### Install the extension locally

For Chromium browsers (Chrome, Brave, Edge, Arc):

1. Open your browser and navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist` directory

For Firefox:

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to the `dist_firefox` directory and select the `manifest.json` file

To install permanently on Firefox Nightly or Developer Edition:

1. Type `about:config` in the URL bar
2. Search for `xpinstall.signatures.required`
3. Double-click to set it to `false`
4. Go to `about:addons` > gear icon > **Install Add-on From File…**

## License

MIT — Same as the [original project](https://github.com/obsidianmd/obsidian-clipper).
