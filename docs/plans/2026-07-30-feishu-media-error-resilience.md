# Feishu Media Error Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve actionable Feishu API diagnostics and make small image-only bridge saves use the existing resumable retry path without weakening URL or credential boundaries.

**Architecture:** Keep Feishu credentials and API parsing in the extension, but return sanitized `code`/`msg` diagnostics from temporary-download lookups. Prefer the companion's existing resumable protocol whenever it advertises support; retain the transaction protocol only for older companions and give that compatibility path one retry for transient download failures. Keep the direct-media allowlist closed and log only rejected media-like hostnames until a real signed URL provides evidence for a safe expansion.

**Tech Stack:** TypeScript, WebExtension background service worker, Obsidian companion plugin protocol, Vitest.

---

## Audit decisions

- **Immediate fix — error envelope:** Confirmed. `getFeishuTemporaryMediaUrl` discards a non-zero Feishu `code` and `msg`, then `openFeishuBridgeAsset` reports only the transport status.
- **Immediate fix — small-document resilience:** Confirmed that one failed asset aborts the legacy transaction. Do not silently commit an incomplete note: protocol v1 requires every declared asset and the accepted resumable design commits only when all required assets complete. Instead, use resumable sessions for every capable companion and add one transient retry to the legacy compatibility path.
- **Immediate fix — fallback diagnostics:** Confirmed with a narrower consequence than reported. A failing fallback throws its own error rather than the generic no-address error, but it still discards the earlier Open API error. Combine the two sanitized diagnostics.
- **Diagnostic fix only — direct-media headers and hosts:** The allowlist excludes unknown Lark/CDN hosts, but no captured signed URL proves which additional host is required. Adding `Referer` can disclose a document URL and setting `User-Agent` from browser fetch is not a safe equivalent of the Bilibili rule. Log rejected media-like hostnames; keep the allowlist and request headers unchanged.
- **No fix — filename drift claim:** `save.ts` sanitizes the note path, not attachment filenames. The resume key is based on source URL, note path, behavior, asset kind/token identity, and occurrence count, not generated filenames. The two attachment filename functions also intentionally differ on extension handling.

### Task 1: Preserve temporary-download API errors

**Files:**
- Modify: `src/platforms/feishu/background.ts`
- Test: `src/platforms/feishu/background.test.ts`

**Step 1: Write the failing test**

Add a test where both temporary-download endpoints return HTTP 200 with:

```ts
{
	code: 99991672,
	msg: 'Access denied for document doxcn123456789012345678901234',
}
```

Assert that the thrown error contains the Feishu error code, contains a sanitized message, and does not contain the document identifier.

**Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run src/platforms/feishu/background.test.ts
```

Expected: the new assertion receives `飞书图片下载失败 (HTTP 200)`.

**Step 3: Implement bounded, sanitized envelope parsing**

Add extension-side helpers equivalent to the companion's error-envelope safety:

- bound diagnostic JSON to 64 KiB;
- retain numeric or string `code`;
- sanitize URLs, long identifiers, control characters, and excess whitespace from `msg`/`message`;
- return an `Error` from `getFeishuTemporaryMediaUrl` when the envelope is non-zero or the response has no matching media token.

**Step 4: Run test to verify it passes**

Run the focused background test and expect all cases to pass.

### Task 2: Preserve both API and page-fallback failures

**Files:**
- Modify: `src/platforms/feishu/background.ts`
- Test: `src/platforms/feishu/background.test.ts`

**Step 1: Write the failing test**

Make the Open API temporary lookup return a sanitized Feishu business error and make the allowed page fallback return HTTP 403. Assert that the final error contains both the page-fallback status and the Open API business code.

**Step 2: Run test to verify it fails**

Expected: only `飞书页面媒体下载失败 (HTTP 403)` is present.

**Step 3: Combine diagnostics**

Catch a fallback failure and append the earlier sanitized Open API error. When no fallback exists, prefer the captured API error over the generic last HTTP status.

**Step 4: Run test to verify it passes**

Run the focused background test and expect both diagnostic assertions to pass.

### Task 3: Make small image-only saves resilient

**Files:**
- Modify: `src/platforms/feishu/background.ts`
- Test: `src/platforms/feishu/background.test.ts`
- Test: `src/platforms/feishu/bridge-background.test.ts`
- Modify: `docs/plans/2026-07-25-feishu-resumable-media-design.md`
- Modify: `docs/feishu-media-storage.md`

**Step 1: Write failing selection and retry tests**

- Assert that a companion advertising `resumable-remote-media-v1` is selected for a one-image document.
- Assert that the legacy transaction path retries one transient HTTP 503 download once and succeeds.
- Assert that a permanent permission error is not retried.

**Step 2: Run tests to verify they fail**

Run:

```powershell
npx vitest run src/platforms/feishu/background.test.ts src/platforms/feishu/bridge-background.test.ts
```

Expected: the current threshold keeps the one-image document on the transaction path, and the transient download is attempted once.

**Step 3: Implement minimal resilience**

- Remove the 40-asset selection threshold; any capable companion uses the resumable path.
- Keep the transaction path for older companion versions.
- In that compatibility path, retry only network failures, Feishu rate-limit code `99991400`, HTTP 408/425/429, and HTTP 5xx once.
- Do not retry permission, token, allowlist, size, cancellation, or other permanent errors.

**Step 4: Update design and user documentation**

Document that current companions use resumable sessions for all locally saved Feishu media, while older companions retain the bounded compatibility transaction.

**Step 5: Run focused tests**

Expect the selection, retry, abort, and existing bridge tests to pass.

### Task 4: Log rejected direct-media hostnames without widening trust

**Files:**
- Modify: `src/utils/feishu-extractor.ts`
- Test: `src/utils/feishu-extractor.test.ts` if an existing suitable test module exists; otherwise extend the closest Feishu extractor test.

**Step 1: Add a diagnostic test where practical**

Feed a media-like Lark CDN URL that is outside the allowlist and verify it is not accepted. Keep the hostname visible in debug diagnostics but never log path, query, media token, document token, or authorization.

**Step 2: Implement hostname-only diagnostic logging**

Aggregate unique rejected Feishu/Lark media-like hostnames during DOM/performance collection and emit one debug record per extraction.

**Step 3: Keep unsafe proposals out**

Do not:

- add an unverified wildcard host;
- attach the source document URL as `Referer`;
- attempt to override `User-Agent`;
- send cookies to signed media URLs.

### Task 5: Verification

**Step 1: Run focused tests**

```powershell
npx vitest run src/platforms/feishu/background.test.ts src/platforms/feishu/bridge-background.test.ts companion-plugin/src/remote-media-downloader.test.ts
```

**Step 2: Run type checks**

```powershell
npm run typecheck
npm run typecheck:companion
```

**Step 3: Run repository checks**

```powershell
npm run check
```

**Step 4: Confirm scope**

Run `git diff --check`, inspect `git diff --stat`, and verify no credentials, tokens, generated build output, or unrelated user changes were added.
