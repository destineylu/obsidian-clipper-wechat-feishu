# Upstream Sync Guide

This fork is based on the official Obsidian Web Clipper, but keeps Chinese platform enhancements in a small platform layer so official updates can be merged with less conflict.

## Branch model

- `main`: stable release branch for this fork.
- `upstream/main`: official `obsidianmd/obsidian-clipper` branch.
- `sync-upstream-YYYYMMDD`: temporary branch for each official merge.

Recommended remotes:

```bash
git remote add upstream https://github.com/obsidianmd/obsidian-clipper.git
git remote add wechat-feishu https://github.com/destineylu/obsidian-clipper-wechat-feishu.git
```

## Custom code boundary

Keep custom site behavior in `src/platforms/*`:

- `src/platforms/wechat/extractor.ts`: WeChat lazy image normalization, article fallback, and video fallback links.
- `src/platforms/feishu/extractor.ts`: Feishu/Lark facade for structured document and media handling.
- `src/platforms/bilibili/extractor.ts`: Bilibili facade for reader/video extraction.

Official-like core files should only call these platform hooks:

- `src/content.ts`
- `src/utils/content-extractor.ts`
- `src/utils/reader.ts`

The lower-level utility files under `src/utils/*-extractor.ts` can stay as implementation detail for now, but new feature entry points should go through `src/platforms`.

## Sync workflow

1. Save the current fork state:

```bash
npm run sync:official-version
git status --short
npm run build:chrome
npm run check:custom-platforms
```

2. Fetch official changes:

```bash
git fetch upstream
git checkout -b sync-upstream-YYYYMMDD main
git merge upstream/main
```

3. Resolve conflicts conservatively:

- Prefer official changes in generic UI, template, settings, Reader Mode, build config, and shared utilities.
- Preserve the imports from `src/platforms/*` in the official-like core files.
- Keep Feishu settings fields and media policy defaults unless the product decision changes.
- Keep README sections that explain this fork's Feishu and WeChat behavior.

4. Verify:

```bash
npm run check:custom-platforms
npm run build:chrome
npm run test
```

5. Manual regression checklist:

- Feishu `/docx/` document with text, headings, lists, tables, and images.
- Feishu `/wiki/` document.
- Feishu image-heavy document with "Download images" off: should save links and remain fast.
- Feishu image-heavy document with "Download images" on: should show warning when image count is high.
- WeChat article with many lazy-loaded images.
- WeChat article with video: should keep cover/original article playback link rather than a temporary mp4 URL.
- Bilibili Reader Mode transcript, timestamps, and playback tracking.

6. Merge back:

```bash
git checkout main
git merge sync-upstream-YYYYMMDD
git push wechat-feishu main
```

## Guardrail

Run this after every upstream merge:

```bash
npm run check:custom-platforms
```

The check fails if official-like files bypass `src/platforms/*` and import Feishu/Bilibili extractors directly again. This keeps future merges easier to review.

## Version policy

This fork intentionally keeps `package.json` and all browser manifest versions aligned with the official released Obsidian Web Clipper version. Do not bump this fork independently.

- Local builds run `scripts/sync-official-version.mjs` before browser builds.
- By default, the sync script reads the official Chrome Web Store update metadata for extension ID `cnjifjpddelmedmihgijeibhnjfabmlf`, which tracks the version users actually install.
- GitHub Actions runs `.github/workflows/sync-official-version.yml` daily and commits a version-only update when the official released version changes.
- If the official version source is unreachable during a local build, the script keeps the current checked-in version so development can continue.

Manual override for emergency releases:

```bash
OFFICIAL_CLIPPER_VERSION=1.6.1 npm run sync:official-version
```

To intentionally follow the official GitHub `main` branch instead of the released browser extension:

```bash
OFFICIAL_CLIPPER_VERSION_SOURCE=github-main npm run sync:official-version
```
