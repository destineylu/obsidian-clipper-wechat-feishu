# Multi-engine Documentation Clipping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add one-click, current-language whole-document clipping for Claude Platform and Gemini API documentation with safe resumable Companion writes.

**Architecture:** Generalize Sphinx discovery behind a document-source adapter contract. Normalize all sources into the existing manifest/output pipeline, then add a Companion v2 collection session that writes bounded transactional batches and persists ownership and resume state.

**Tech Stack:** TypeScript, WebExtension APIs, Defuddle, Obsidian API, Node HTTP, Vitest.

---

### Task 1: General document source model

**Files:**
- Modify: `src/core/document-bundle.ts`
- Test: `src/core/document-bundle.test.ts`

1. Add failing tests for source kinds, stable collection IDs, locale roots and Markdown page collection.
2. Run `npm.cmd test -- --run src/core/document-bundle.test.ts` and confirm failure.
3. Generalize `DocumentManifest` and collection without changing Sphinx output.
4. Re-run the targeted tests and confirm success.

### Task 2: Claude and Google discovery adapters

**Files:**
- Modify: `src/core/document-bundle.ts`
- Test: `src/core/document-bundle.test.ts`

1. Add fixtures for Claude `llms.txt`, Google sitemap indexes/shards and DevSite canonical pages.
2. Add failing tests for locale filtering, de-duplication and unsafe URLs.
3. Implement `llms.txt` and Google DevSite discovery behind the common adapter interface.
4. Run the targeted tests.

### Task 3: Resumable Companion collection sessions

**Files:**
- Modify: `src/platforms/feishu/bridge-protocol.ts`
- Modify: `src/platforms/feishu/bridge-client.ts`
- Modify: `companion-plugin/src/server.ts`
- Modify: `companion-plugin/src/types.ts`
- Modify: `companion-plugin/src/obsidian-vault-writer.ts`
- Create: `companion-plugin/src/document-collection-store.ts`
- Test: corresponding `*.test.ts` files

1. Add failing protocol, ownership, batching, rollback and resume tests.
2. Advertise `document-bundle-resumable-v2` and expose create/status/batch endpoints.
3. Persist collection manifests in Companion plugin data.
4. Write at most 50 notes or 10 MiB per transaction; skip unchanged hashes.
5. Re-run Companion and bridge tests.

### Task 4: Popup integration

**Files:**
- Modify: `src/core/popup.ts`
- Modify: `src/popup.html`
- Modify: `src/side-panel.html`
- Modify: `src/_locales/en/messages.json`
- Modify: `src/_locales/zh_CN/messages.json`
- Modify: `src/styles/popup.scss`

1. Detect all supported adapters and display the action on recognized pages.
2. Show locale, page count, save mode and resume counts before writing.
3. Continue page collection despite individual failures and show four-stage progress.
4. Require Companion above 100 pages and retain merged fallback below 100.
5. Add retry/resume controls and localized errors.

### Task 5: Documentation and validation

**Files:**
- Modify: `docs/Clip web pages.md`
- Modify: `README.md`
- Modify: `README_EN.md`

1. Document supported engines, current-language scope, limits, remote images and resume behavior.
2. Run `npm.cmd run check` and Companion type checks/tests.
3. Run `npm.cmd run build:chrome` and `npm.cmd run build:companion`.
4. Run `git diff --check`.
5. Reload the unpacked extension in the existing port 19222 browser and verify Claude, Gemini and Sphinx without launching another browser.
