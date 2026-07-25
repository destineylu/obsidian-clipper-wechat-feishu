# Upstream Sync Guide

This fork is based on the official Obsidian Web Clipper, but keeps Chinese platform enhancements in a small platform layer so official updates can be merged with less conflict.

## Branch model

- `main`: stable release branch for this fork.
- `upstream/main`: official `obsidianmd/obsidian-clipper` branch.
- `official-snapshot`: linear, tree-exact snapshots of official source.
- `codex/sync-upstream-YYYYMMDD`: temporary branch for each official merge.

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
- `src/core/reader-view.ts`
- `src/utils/clip-utils.ts`
- `src/utils/content-extractor.ts`
- `src/utils/reader.ts`

The lower-level utility files under `src/utils/*-extractor.ts` can stay as implementation detail for now, but new feature entry points should go through `src/platforms`.

## Sync workflow

1. Verify the current fork state without changing its version:

```powershell
git status --short
npm run check
npm run build
```

2. Preserve the current official baseline before the first real upstream fetch:

```powershell
git branch official-snapshot eae51b9e9d5ea4353ffcf61dd83fd2708afdbed4
```

This repository used a synthetic, tree-exact official `1.7.1` snapshot after a Windows TLS failure. Do not directly merge the unrelated real `upstream/main` history, because that would replay the full official delta.

3. Fetch official changes and create the next tree-exact snapshot:

```powershell
git fetch upstream
$previousSnapshot = git rev-parse official-snapshot
$officialTree = git rev-parse 'upstream/main^{tree}'
$version = (git show upstream/main:package.json | Out-String | ConvertFrom-Json).version
$newSnapshot = git commit-tree $officialTree -p $previousSnapshot -m "chore: snapshot official upstream $version"
git update-ref refs/heads/official-snapshot $newSnapshot $previousSnapshot

git switch main
git switch -c "codex/sync-upstream-$((Get-Date).ToString('yyyyMMdd'))"
git merge official-snapshot
```

4. Resolve conflicts conservatively:

- Prefer official changes in generic UI, template, settings, Reader Mode, build config, and shared utilities.
- Preserve the imports from `src/platforms/*` in the official-like core files.
- Keep Feishu settings fields and media policy defaults unless the product decision changes.
- Keep README sections that explain this fork's Feishu and WeChat behavior.

5. Align the checked-in version only after the source merge:

```powershell
$env:OFFICIAL_CLIPPER_VERSION = $version
npm run sync:official-version
Remove-Item Env:OFFICIAL_CLIPPER_VERSION
```

6. Verify:

```powershell
npm run check
npm run build
npm audit --omit=dev --audit-level=low
git diff --check
```

The normal build is offline and must not modify package or manifest versions.

7. Manual regression checklist:

- Feishu `/docx/` document with text, headings, lists, tables, and images.
- Feishu `/wiki/` document.
- Feishu image-heavy document with local companion images and linked videos/files.
- Feishu mixed-media document with linked images and local companion videos/files.
- Feishu mixed-media document with both controls local: should resume interrupted downloads.
- Feishu lightweight configuration with both controls linked: should not invoke the companion.
- WeChat article with many lazy-loaded images.
- WeChat article with video: should keep cover/original article playback link rather than a temporary mp4 URL.
- Bilibili Reader Mode transcript, timestamps, and playback tracking.

8. Merge back:

```powershell
git checkout main
git merge "codex/sync-upstream-$((Get-Date).ToString('yyyyMMdd'))"
git push wechat-feishu main
```

## Guardrail

Run the full guardrail after every upstream merge:

```powershell
npm run check
```

The check fails if official-like files bypass `src/platforms/*` and import Feishu/Bilibili extractors directly again. This keeps future merges easier to review.

## Version policy

This fork intentionally keeps `package.json` and all browser manifest versions aligned with the official released Obsidian Web Clipper version. Do not bump this fork independently.

- Browser builds use the checked-in version and do not access the network or modify source files.
- The sync script reads official release metadata only when explicitly invoked.
- GitHub Actions checks daily for a new official release and fails visibly; it never changes version numbers without the corresponding source update.
- A version bump must be committed in the same reviewed change as the matching official source sync.

Manual override for emergency releases:

```powershell
$env:OFFICIAL_CLIPPER_VERSION = '1.7.1'
npm run sync:official-version
Remove-Item Env:OFFICIAL_CLIPPER_VERSION
```

To intentionally follow the official GitHub `main` branch instead of the released browser extension:

```powershell
$env:OFFICIAL_CLIPPER_VERSION_SOURCE = 'github-main'
npm run sync:official-version
Remove-Item Env:OFFICIAL_CLIPPER_VERSION_SOURCE
```
