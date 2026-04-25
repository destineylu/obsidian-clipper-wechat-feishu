# Obsidian Web Clipper (Chinese Content Enhanced)

> This project is built on top of the official [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper). It keeps the official template, variable, Reader Mode, and Obsidian capture workflow, while focusing its custom work on better extraction for **Feishu/Lark documents** and **WeChat Official Account articles**.

[中文说明](./README.md)

## What's different from the official version?

The official Obsidian Web Clipper uses a generic article extractor for most pages. That works well for ordinary websites, but Chinese content platforms such as Feishu/Lark and WeChat Official Accounts often rely on dynamic rendering, lazy-loaded images, complex article containers, and temporary signed media URLs. The result can be incomplete content, missing images, broken video links, or Obsidian notes that become slow to open when too many images are embedded.

This fork focuses on:

- Adding site-specific extraction on top of the official extension
- Preserving the official template and variable pipeline
- Protecting Obsidian from very large media-heavy notes
- Keeping a reliable original-page playback entry for videos that cannot be saved as stable standalone files

### Feishu/Lark document extraction

The official version extracts Feishu document content via generic DOM parsing, which often returns incomplete results due to Feishu's dynamic rendering. This fork integrates the **Feishu Open Platform API** to fetch document content through structured endpoints:

- **Complete content** — Retrieves all document blocks including text, headings, lists, code blocks, tables, quotes, and more
- **Wiki support** — Works with both Feishu Wiki (`/wiki/`) and regular document (`/docx/`) URLs
- **Structure preserved** — Maintains the original document hierarchy, converted to standard HTML for Obsidian Clipper to process
- **Media protection** — Feishu images are not inlined by default; the note keeps clickable links so Obsidian opens quickly
- **Manual image download** — Turn on "Download images" only when you need a complete image-heavy note; the extension warns when image counts are high
- **Video/file fallback links** — Videos and attachments that cannot be reliably inlined are kept as accessible links instead of broken placeholders

#### How to choose the Feishu "Download images" setting

The extension provides a **Feishu / Lark → Download images** toggle in settings. It is off by default. Recommended usage:

- **Keep it off by default**: Best for most Feishu documents, especially screenshot-heavy tutorials. Images are saved as links, keeping Markdown lightweight and Obsidian fast.
- **Turn it on manually**: Use only when you need a complete offline copy of a document with images, such as a small document that needs formal archiving.
- **Be careful with large documents**: Feishu images are not ordinary public image URLs like WeChat article images. They must be fetched through the Feishu API and converted into accessible media content. With many images, note size and Obsidian rendering cost increase quickly.
- **Risk threshold**: Around 30 images can become noticeably slow; 50 or more may make the note impossible to open in Obsidian. If this happens, turn off "Download images" and clip again as image links.

WeChat Official Account images are usually saved as remote `mmbiz.qpic.cn` links and loaded on demand by Obsidian. Feishu images require authenticated fetching and conversion, so large image-heavy documents behave differently.

**Setup:**

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and create a custom app
2. Grant the app these permissions: `docx:document:readonly`, `wiki:node:read`
3. Get the App ID and App Secret (see [official docs: Get access token](https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-access-token#63c75bdc))
4. Open Obsidian Web Clipper → click **Settings** (top-right) → **General** → find the **Feishu / Lark** section → enter your App ID and App Secret

> **Privacy note**: App ID and App Secret are stored only in your local browser storage (`browser.storage.local`) and are never sent to any third-party server.

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

### Why not merged upstream?

The official maintainer [indicated](https://github.com/obsidianmd/obsidian-clipper/pull/1) that site-specific content extractors should be implemented in [Defuddle](https://github.com/kepano/defuddle) (the content extraction library), not in the Web Clipper extension itself. Feishu/Lark, WeChat, and Bilibili require more site-specific compatibility logic, so this fork maintains those changes independently for Chinese content users who need them now.

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
