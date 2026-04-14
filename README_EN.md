# Obsidian Web Clipper (Chinese Content Enhanced)

> This is a fork of the official [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper), enhanced for Chinese content platforms.

[中文说明](./README.md)

## What's different from the official version?

This fork adds **Bilibili video support** in Reader Mode, bringing the same experience as the official YouTube integration:

- **Content extraction** — Extracts video description, chapters, and subtitles/transcript from Bilibili pages
- **Video embed** — Embeds Bilibili player in Reader Mode with sticky pin-player support
- **Clickable timestamps** — Click any subtitle or chapter timestamp to seek the video
- **Auto-scroll** — Automatically scrolls the transcript to follow playback
- **Highlight active line** — Highlights the current subtitle line during playback
- **Cross-browser support** — Works on Chrome and Firefox with proper `Referer` header handling

### Why not merged upstream?

The official maintainer [indicated](https://github.com/obsidianmd/obsidian-clipper/pull/1) that site-specific content extractors should be implemented in [Defuddle](https://github.com/kepano/defuddle) (the content extraction library), not in the Web Clipper extension itself. Since integrating Bilibili support into Defuddle would require a different architectural approach, this fork maintains the feature independently for users who need it now.

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
