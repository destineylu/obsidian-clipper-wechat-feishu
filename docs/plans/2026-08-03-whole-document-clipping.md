# Whole-document Clipping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build one-click Sphinx documentation collection with chapter-folder output through the paired companion plugin and a merged-note fallback.

**Architecture:** A pure discovery and bundle builder module parses Sphinx search indexes and clips fetched pages with the existing API. The popup invokes it and writes through a new authenticated companion endpoint, falling back to the existing single-note transport when the endpoint is unavailable.

**Tech Stack:** TypeScript, WebExtension APIs, Defuddle clipping API, Obsidian plugin Vault API, Vitest.

---

### Task 1: Sphinx discovery and bundle construction

**Files:**
- Create: `src/core/document-bundle.ts`
- Test: `src/core/document-bundle.test.ts`

**Steps:**
1. Write failing tests for Sphinx wrapper parsing, safe page resolution, page limits, chapter paths, index links, and merged Markdown.
2. Run `npx vitest run src/core/document-bundle.test.ts` and verify failure.
3. Implement pure parsing, validation, manifest, and output helpers plus a bounded-concurrency collector using the existing `clip` API.
4. Run the targeted tests and verify they pass.

### Task 2: Authenticated document-bundle companion endpoint

**Files:**
- Modify: `src/platforms/feishu/bridge-protocol.ts`
- Modify: `src/platforms/feishu/bridge-client.ts`
- Modify: `companion-plugin/src/server.ts`
- Modify: `companion-plugin/src/types.ts`
- Modify: `companion-plugin/src/obsidian-vault-writer.ts`
- Modify: `companion-plugin/src/main.ts`
- Test: `companion-plugin/src/server.test.ts`
- Test: `companion-plugin/src/obsidian-vault-writer.test.ts`

**Steps:**
1. Add failing protocol/server tests for capability discovery, valid writes, unsafe paths, duplicate paths, count limits, and byte limits.
2. Add failing writer tests proving overwrite/create behavior and rollback.
3. Run both targeted test files and verify failure.
4. Implement request/response types, client call, route validation, capability advertisement, and transactional writer method.
5. Run both targeted test files and verify they pass.

### Task 3: Popup action, confirmation, and progress

**Files:**
- Modify: `src/core/popup.ts`
- Modify: `src/popup.html`
- Modify: `src/side-panel.html`
- Modify: `src/styles/popup.scss`
- Modify: `src/_locales/en/messages.json`
- Modify: `src/_locales/zh_CN/messages.json`

**Steps:**
1. Add a reusable documentation progress panel to popup and side-panel markup.
2. Add the secondary action and Sphinx discovery confirmation.
3. Collect with concurrency three and render page-by-page progress.
4. Detect the companion capability and write chapter notes plus index; otherwise save merged output and explain the fallback.
5. Add English and Simplified Chinese strings; untranslated locales use the English fallback behavior already provided by i18n.

### Task 4: Verification and documentation

**Files:**
- Modify: `docs/Clip web pages.md`

**Steps:**
1. Document supported Sphinx sites, companion chapter mode, merged fallback, page limits, and overwrite/no-delete behavior.
2. Run `npm run typecheck` and `npm run typecheck:companion`.
3. Run targeted tests and then `npm test`.
4. Run `npm run build:chrome`, `npm run build:companion`, and `git diff --check`.
5. Inspect the final diff and report any pre-existing untracked files separately.
