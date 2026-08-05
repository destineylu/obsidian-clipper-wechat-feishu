# VitePress Documentation Collection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add VitePress whole-document discovery so supported VitePress sites can be saved through the existing Obsidian document-bundle workflow.

**Architecture:** Detect VitePress from its runtime markers, parse the official embedded `__VP_SITE_DATA__` sidebar and base path into a normalized document manifest, and reuse the existing page collection, navigation, Companion, and merged-note pipelines. Reject cross-origin and unsafe links instead of recursively crawling unrelated page links.

**Tech Stack:** TypeScript, Vitest, linkedom test fixtures, existing document-bundle adapters and Companion transport.

---

### Task 1: Add VitePress fixture tests

**Files:**
- Modify: `src/core/document-bundle.test.ts`

**Step 1:** Add detection coverage for VitePress runtime markers and assert existing source detection remains unchanged.

**Step 2:** Add a fixture containing VitePress `window.__VP_SITE_DATA__`, sidebar groups, locale metadata, and `.html` page URLs.

**Step 3:** Assert the manifest contains the current-language pages in sidebar order, preserves group navigation, resolves the `/docs/` base path, and rejects external links.

**Step 4:** Run `npx vitest run src/core/document-bundle.test.ts` and confirm the new tests fail before implementation.

### Task 2: Implement VitePress parsing and discovery

**Files:**
- Modify: `src/core/document-bundle.ts`

**Step 1:** Add `vitepress` to `DocumentSourceKind` and detect VitePress markers without classifying ordinary pages that only contain a generic sidebar.

**Step 2:** Parse the escaped `window.__VP_SITE_DATA__` payload safely, select the active locale configuration, and normalize sidebar arrays or path-keyed sidebar objects.

**Step 3:** Convert only same-origin sidebar links under the VitePress base path into safe page manifests, normalize clean URLs to the deployed `.html` form, deduplicate pages, and retain navigation groups.

**Step 4:** Add the VitePress adapter to `DOCUMENT_SOURCE_ADAPTERS` and route discovery through the shared manifest pipeline.

**Step 5:** Run the focused tests and confirm all pass.

### Task 3: Verify integration and production checks

**Files:**
- Modify: `README.md` if supported-source documentation lists are maintained there.

**Step 1:** Run `npm run typecheck` and `npm test`.

**Step 2:** Run `npm run check` and `git diff --check`.

**Step 3:** Build the Chrome extension if the focused checks pass, then report the generated artifact and exact user workflow.
