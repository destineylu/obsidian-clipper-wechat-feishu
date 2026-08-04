# Documentation Hierarchy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve Sphinx navigation hierarchy in the Obsidian index, note folders, and merged document headings.

**Architecture:** Extend the document manifest with an ordered navigation tree parsed from the root Sphinx page. Keep `searchindex.js` as the completeness source and fall back to `docname` paths when navigation markup is unavailable. Render all three outputs from the same normalized tree.

**Tech Stack:** TypeScript, DOMParser/linkedom, Defuddle, Vitest, WebExtension MV3, Markdown.

---

### Task 1: Parse and normalize Sphinx navigation

**Files:**
- Modify: `src/core/document-bundle.ts`
- Test: `src/core/document-bundle.test.ts`

1. Add failing fixtures for a nested Sphinx sidebar, duplicate links, and missing navigation pages.
2. Run `npm.cmd test -- --run src/core/document-bundle.test.ts` and confirm failure.
3. Add `DocumentNavigationNode`, URL canonicalization, DOM tree parsing, and `docname` fallback construction.
4. Attach the normalized tree to `DocumentManifest` without changing the page completeness rules.
5. Re-run the targeted test and confirm it passes.

### Task 2: Render nested index and folder hierarchy

**Files:**
- Modify: `src/core/document-bundle.ts`
- Test: `src/core/document-bundle.test.ts`

1. Add a failing output test that expects nested Wiki list indentation and ancestor folders.
2. Walk the navigation tree in display order and map each page to its ancestor nodes.
3. Keep the root index page at the bundle root and place child pages under sanitized ancestor folders.
4. Append unreferenced search-index pages through the fallback tree.
5. Re-run the targeted test and confirm it passes.

### Task 3: Normalize merged document headings

**Files:**
- Modify: `src/core/document-bundle.ts`
- Test: `src/core/document-bundle.test.ts`

1. Add failing tests for leading title removal, nested page depth, heading shifting, level-six capping, and fenced code preservation.
2. Implement a pure Markdown heading normalizer.
3. Render group/page headings according to navigation depth and place body headings one level below the page.
4. Re-run the targeted test and confirm it passes.

### Task 4: Fetch navigation markup during discovery

**Files:**
- Modify: `src/core/document-bundle.ts`
- Modify: `src/core/popup.ts`
- Test: `src/core/document-bundle.test.ts`

1. Extend discovery with an optional `DocumentParser`.
2. Fetch the resolved root `index.html`, parse navigation when available, and retain a fallback on fetch or parse failure.
3. Pass the browser DOM parser from the popup.
4. Verify existing discovery and collection behavior remains compatible.

### Task 5: Validate and package

**Files:**
- Verify: `src/core/document-bundle.ts`
- Verify: `src/core/document-bundle.test.ts`
- Verify: `src/core/popup.ts`

1. Run `npm.cmd run check` and expect every check and test to pass.
2. Run `npm.cmd run build:chrome` and expect a successful production build.
3. Run `git diff --check` and inspect the scoped diff.
4. Reload only the unpacked extension in the existing `http://127.0.0.1:19222` session and confirm zero manifest errors.
