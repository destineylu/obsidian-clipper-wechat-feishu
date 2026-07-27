# Feishu Resumable Media Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add resumable, popup-independent binary transfer for Feishu images, videos, and files, then verify it against the authenticated 269-image test document.

**Architecture:** The extension emits typed media markers and resolves temporary Feishu URLs. The Obsidian companion validates and downloads those URLs directly into a persistent session, reports progress, resumes missing assets, and commits the final note only when every attachment is ready.

**Tech Stack:** TypeScript, WebExtension MV3, Node HTTP/fetch/streams, Obsidian Plugin API, Vitest, esbuild.

> Repository note: the user explicitly prohibited committing to the current
> `codex/upgrade-official-1.7.1` branch. Commit steps are intentionally omitted; all
> changes remain reviewable in the working tree.

---

### Task 1: Typed media markers and sanitized session content

**Files:**
- Modify: `src/platforms/feishu/bridge-protocol.ts`
- Modify: `src/platforms/feishu/bridge-protocol.test.ts`
- Modify: `src/platforms/feishu/markdown.ts`
- Modify: `src/platforms/feishu/markdown.test.ts`
- Modify: `src/platforms/feishu/save.ts`
- Modify: `src/platforms/feishu/save.test.ts`

**Steps:**

1. Add failing tests for image, image-file, video, and file markers.
2. Add `kind`, `downloadKind`, and `embed` metadata to extracted assets.
3. Add a pure helper that replaces private markers with opaque
   `feishu-session://asset/<index>` markers before content crosses loopback.
4. Extend Markdown conversion so video/file placeholders become typed bridge markers
   only in companion mode.
5. Verify focused tests fail first and then pass.

### Task 2: Persistent resumable session store

**Files:**
- Create: `companion-plugin/src/resumable-session-store.ts`
- Create: `companion-plugin/src/resumable-session-store.test.ts`
- Modify: `companion-plugin/src/types.ts`
- Modify: `companion-plugin/src/obsidian-vault-writer.ts`
- Modify: `companion-plugin/src/obsidian-vault-writer.test.ts`

**Steps:**

1. Add failing tests for create/resume, manifest reload, completed-asset reuse,
   expiry, retry, and final commit.
2. Persist a redacted JSON manifest and `.part` files below the companion plugin
   session directory.
3. Never persist a remote URL, header, Feishu token, or source document URL.
4. Stream one asset at a time into Vault and replace opaque markers during final
   commit.
5. Run the focused companion tests.

### Task 3: Authenticated remote download queue

**Files:**
- Create: `companion-plugin/src/remote-media-downloader.ts`
- Create: `companion-plugin/src/remote-media-downloader.test.ts`
- Modify: `companion-plugin/src/resumable-session-store.ts`

**Steps:**

1. Add failing tests for allowed hosts, redirect validation, byte limits, cancellation,
   hash calculation, and retry.
2. Validate HTTPS URLs and every redirect against the Feishu media allowlist.
3. Stream response chunks directly to the session `.part` file.
4. Enforce separate image and video/file limits plus a session total limit.
5. Keep URLs in queue memory only and redact thrown errors.

### Task 4: Session HTTP API and client

**Files:**
- Modify: `src/platforms/feishu/bridge-protocol.ts`
- Modify: `src/platforms/feishu/bridge-client.ts`
- Modify: `src/platforms/feishu/bridge-client.test.ts`
- Modify: `companion-plugin/src/server.ts`
- Modify: `companion-plugin/src/server.test.ts`

**Steps:**

1. Add health capabilities and session request/response types.
2. Add `POST /v1/sessions`, `GET /v1/sessions/{id}`,
   `POST /v1/sessions/{id}/queue`, `POST /v1/sessions/{id}/commit`, and
   `DELETE /v1/sessions/{id}`.
3. Keep existing transaction routes unchanged.
4. Add authenticated client methods and stable redacted error envelopes.
5. Run client and server tests.

### Task 5: Companion lifecycle, limits, and installation build

**Files:**
- Modify: `companion-plugin/src/main.ts`
- Modify: `companion-plugin/src/settings.ts`
- Modify: `companion-plugin/src/types.ts`
- Modify: `companion-plugin/manifest.json`
- Modify: `companion-plugin/styles.css`

**Steps:**

1. Add settings defaults for 64 MiB images, 4 GiB video/files, 20 GiB sessions,
   24-hour retention, and bounded concurrency.
2. Resolve a persistent desktop session directory.
3. Reload resumable manifests before starting the HTTP server.
4. Dispose active downloads without deleting completed resumable data on unload.
5. Build and reinstall the companion into the approved test Vault.

### Task 6: Browser URL resolution and resumable orchestration

**Files:**
- Modify: `src/platforms/feishu/background.ts`
- Modify: `src/platforms/feishu/bridge-background.test.ts`
- Create: `src/platforms/feishu/bridge-progress.ts`
- Create: `src/platforms/feishu/bridge-progress.test.ts`

**Steps:**

1. Add failing tests for batched temporary URL resolution, resume keys, queue retry,
   popup-independent polling, and redacted persisted progress.
2. Resolve temporary media URLs in bounded batches using the existing tenant token.
3. Create/resume a companion session, queue only missing assets, and persist the
   session ID under a SHA-256 source key.
4. Poll status while the message port remains available; rely on companion autonomous
   completion after popup closure.
5. Add status and retry message handlers.

### Task 7: Popup progress and completion UI

**Files:**
- Modify: `src/core/popup.ts`
- Modify: `src/popup.html`
- Modify: `src/styles/popup.scss`
- Modify: `src/_locales/en/messages.json`
- Modify: `src/_locales/zh_CN/messages.json`

**Steps:**

1. Add a progress region with phase, asset count, bytes, speed, and retry text.
2. Restore progress when the popup reopens on the same source document.
3. Keep duplicate-save protection and explicit success confirmation.
4. Verify the four UI states: preparing, downloading, failed/retry, completed.

### Task 8: Automated and authenticated regression

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-regression-checklist.md`

**Steps:**

1. Run focused tests for every new module.
2. Run `npm run check`, `npm run build:companion`, `npm run build:chrome`, and
   `git diff --check`.
3. Reinstall and enable the companion build in the approved Vault.
4. Attach only to `http://127.0.0.1:19222`; never launch another browser.
5. Clip `https://tenant.feishu.cn/docx/<public-test-document-id>`.
6. Verify 269 image markers and 11 video/file markers become existing local Vault
   attachments, the note contains no Base64/private markers, and interruption resumes.
