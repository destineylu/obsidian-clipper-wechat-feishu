# Feishu Attachment Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Desktop-only Obsidian companion and an extension save path that transfers Feishu images as bounded binary attachments instead of Base64 Markdown.

**Architecture:** The browser extension leaves portable Feishu asset markers in the note, downloads authenticated images in the background, and uploads raw bytes through an authenticated loopback transaction. The companion stages uploads in OS temporary files, writes attachments through Obsidian Vault APIs, and commits the final note only after assets are ready.

**Tech Stack:** TypeScript, WebExtension MV3, Node HTTP, Obsidian Plugin API, esbuild, Vitest.

---

### Task 1: Define and test the bridge protocol

**Files:**
- Create: `src/platforms/feishu/bridge-protocol.ts`
- Create: `src/platforms/feishu/bridge-protocol.test.ts`

**Step 1: Write failing validation tests**

Cover endpoint normalization, marker parsing/deduplication, safe filenames, stable
error envelopes, protocol-version mismatch, and rejection of non-loopback endpoints.

**Step 2: Run the focused test**

Run:

```powershell
npm.cmd test -- src/platforms/feishu/bridge-protocol.test.ts
```

Expected: fail because the protocol module does not exist.

**Step 3: Implement the minimal protocol**

Define:

```ts
export const FEISHU_BRIDGE_PROTOCOL_VERSION = 1;
export const FEISHU_BRIDGE_DEFAULT_ENDPOINT = 'http://127.0.0.1:27125';

export interface FeishuBridgeHealth { /* version, vault, limits */ }
export interface FeishuBridgeTransactionRequest { /* note metadata, asset count */ }
export interface FeishuBridgeCommitRequest { content: string }
export interface FeishuBridgeErrorEnvelope { error: { code: string; message: string } }
```

Add pure helpers for endpoint normalization, media marker extraction, marker
replacement, content-type extension mapping, and bounded JSON parsing.

**Step 4: Run the focused test**

Expected: pass.

### Task 2: Implement and test the companion transaction server

**Files:**
- Create: `companion-plugin/src/server.ts`
- Create: `companion-plugin/src/transaction-store.ts`
- Create: `companion-plugin/src/types.ts`
- Create: `companion-plugin/src/server.test.ts`
- Create: `companion-plugin/src/transaction-store.test.ts`

**Step 1: Write failing server tests**

Use an ephemeral loopback port and a fake vault adapter. Verify:

- missing or invalid Bearer token returns `401`;
- non-loopback client is rejected;
- oversized JSON and binary bodies are rejected;
- two assets can be uploaded and committed;
- abort removes the transaction temp directory;
- expired transactions are removed;
- a commit failure invokes rollback.

**Step 2: Run focused tests**

```powershell
npm.cmd test -- companion-plugin/src/server.test.ts companion-plugin/src/transaction-store.test.ts
```

Expected: fail because the server does not exist.

**Step 3: Implement the server**

Use `node:http`, `node:fs`, `node:stream/promises`, `node:os`, and `node:path`.
Write each request stream to an OS temp file while counting bytes. Keep transaction
metadata in memory and expose `start()`, `stop()`, and `abortAll()`.

**Step 4: Run focused tests**

Expected: pass without using a real vault.

### Task 3: Implement the Obsidian companion adapter and build

**Files:**
- Create: `companion-plugin/src/main.ts`
- Create: `companion-plugin/src/obsidian-vault-writer.ts`
- Create: `companion-plugin/src/settings.ts`
- Create: `companion-plugin/manifest.json`
- Create: `companion-plugin/styles.css`
- Create: `companion-plugin/tsconfig.json`
- Create: `scripts/build-companion.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Add the Obsidian API development dependency**

```powershell
npm.cmd install --save-dev obsidian@1.13.1
```

**Step 2: Implement the plugin**

- Mark `isDesktopOnly: true`.
- Start the server after `workspace.onLayoutReady`.
- Generate a 32-byte token and persist only its SHA-256 hash.
- Provide settings for port, attachment folder, per-asset limit, total limit, token
  regeneration, and server status.
- Normalize every vault path.
- Use `Vault.createBinary`, `Vault.create`, and `Vault.process`.
- Use `FileManager.trashFile` for rollback of assets created by the failed transaction.

**Step 3: Add the build**

Bundle CommonJS `main.js` with esbuild and externalize `obsidian`. Copy
`manifest.json` and `styles.css` into `companion-plugin/dist`.

**Step 4: Verify**

```powershell
npm.cmd run typecheck:companion
npm.cmd run build:companion
```

Expected: `main.js`, `manifest.json`, and `styles.css` exist in the distribution.

### Task 4: Add extension bridge settings and health check

**Files:**
- Modify: `src/platforms/settings.ts`
- Modify: `src/settings.html`
- Modify: `src/managers/general-settings.ts`
- Create: `src/platforms/feishu/bridge-client.ts`
- Create: `src/platforms/feishu/bridge-client.test.ts`

**Step 1: Write failing client tests**

Test authenticated health requests, timeouts, protocol mismatch, vault mismatch,
connection errors, and token redaction.

**Step 2: Implement settings migration**

Add `imageMode: 'links' | 'inline' | 'bridge'`, bridge endpoint, pairing token, and
limits. Migrate the old `downloadImages` boolean without changing existing behavior.

**Step 3: Implement the settings UI**

Replace the binary image toggle with a mode dropdown. Show bridge fields and a Test
connection button only in bridge mode.

**Step 4: Verify**

Run focused tests and typecheck.

### Task 5: Emit bridge markers and implement background binary transfer

**Files:**
- Modify: `src/platforms/feishu/markdown.ts`
- Modify: `src/utils/feishu-extractor.ts`
- Modify: `src/platforms/feishu/background.ts`
- Create: `src/platforms/feishu/bridge-background.ts`
- Create: `src/platforms/feishu/bridge-background.test.ts`
- Modify: `src/platforms/feishu/index.ts`

**Step 1: Write failing tests**

Verify:

- bridge mode emits markers instead of Base64 or extension URLs;
- duplicate image tokens upload once;
- each media response is size-limited before upload;
- failed images become original-document fallbacks;
- total budget prevents starting new downloads;
- abort is sent when any fatal bridge request fails;
- request and error output contains no media tokens.

**Step 2: Refactor the bounded media reader**

Expose a raw-byte result alongside the existing data-URL wrapper. Do not convert bytes
to Base64 in bridge mode.

**Step 3: Implement the transaction orchestration**

Start, upload, replace, commit, and abort through the bridge client. Keep concurrency
at two and avoid retaining completed image byte arrays.

**Step 4: Run focused tests**

Expected: all bridge-background and existing Feishu tests pass.

### Task 6: Integrate the Add to Obsidian save hook

**Files:**
- Modify: `src/core/popup.ts`
- Create: `src/platforms/feishu/save.ts`
- Create: `src/platforms/feishu/save.test.ts`

**Step 1: Write failing routing tests**

Verify:

- normal pages still use `saveToObsidian`;
- Feishu link and inline modes still use the official path;
- Feishu bridge mode routes only non-daily behaviors to the companion;
- daily behaviors use the official path with a visible warning;
- bridge failures do not silently fall back to Base64.

**Step 2: Implement the narrow save hook**

Return `{ handled, notePath, warning }` from the Feishu save module. Keep the popup's
generic note rendering and statistics logic unchanged.

**Step 3: Run focused tests**

Expected: pass.

### Task 7: Fix the observed X video fallback regression

**Files:**
- Modify: `src/platforms/x/extractor.ts`
- Modify: `src/platforms/x/extractor.test.ts`

**Step 1: Add the failing fixture**

Create a target X article with a Blob video and no resolvable direct candidate.
Expect an original-post video fallback section.

**Step 2: Implement the fallback**

When the target article has video media but no direct candidate, insert one portable
original-post fallback. Do not emit Blob or extension URLs.

**Step 3: Verify**

Run the X focused test and typecheck.

### Task 8: Full verification and real acceptance

**Files:**
- Modify: `docs/manual-regression-checklist.md`
- Modify: `README.md`

**Step 1: Run automated checks**

```powershell
npm.cmd run check
npm.cmd run build:companion
npm.cmd run build
npm.cmd audit --omit=dev --audit-level=low
git diff --check
```

Expected: all commands pass; browser builds do not modify tracked source.

**Step 2: Install into a dedicated test vault**

Copy only `main.js`, `manifest.json`, and `styles.css` to:

```text
<test-vault>/.obsidian/plugins/clipper-attachment-bridge/
```

Do not test first in the user's primary vault.

**Step 3: Pair and run the real Feishu document**

Attach only to the existing browser at `http://127.0.0.1:19222`. Verify the endpoint
first, load the local extension build without restarting Chrome, configure bridge mode,
and clip the authenticated image-heavy Feishu document into the test vault.

**Step 4: Inspect artifacts**

Verify note text, attachment count, portable links, transaction cleanup, no Base64
image data, no full Feishu identifiers in logs, and acceptable memory behavior.

**Step 5: Re-run Bilibili and X smoke checks**

Confirm Bilibili two-tab isolation remains correct and X video produces a direct URL
or portable original-post fallback.
