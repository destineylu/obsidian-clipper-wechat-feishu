# Feishu Resumable Media Bridge Design

## Status

Accepted on 2026-07-25 for the authenticated test document containing 269 images
and 11 videos or file attachments.

Amended on 2026-07-25 so that image storage and video/large-file storage are
independent user choices. Resumable transfer applies only to categories selected for
local storage.

Amended on 2026-07-30 so that every locally saved media set uses a resumable session
when the paired companion advertises support. The transaction protocol remains only
as compatibility for older companion versions.

## Goal

Save the selected Feishu images, videos, and file attachments into the active Obsidian
Vault without Base64, without keeping the browser popup open, and without restarting
a partially completed transfer from zero. Media configured as link-only must remain
outside the transfer queue.

## Architecture

The existing transaction protocol remains available for older companion versions.
Current companions advertise a resumable session that is used for small image-only,
large, and mixed-media documents alike.

1. The extension converts Feishu image, video, and file placeholders into typed
   bridge markers.
2. Before saving, the background resolves short-lived Feishu download URLs. App ID
   and App Secret never leave the extension. A tenant bearer token may be sent to the
   authenticated loopback companion only when an official API download requires it.
3. The extension creates or resumes a companion session using a SHA-256 resume key.
   The note content sent to the companion contains only opaque asset indexes, not
   Feishu media tokens or document identifiers.
4. The extension queues short-lived URLs and any required bearer token in memory. The
   companion validates every redirect, forwards authorization only to allowed official
   API download endpoints, and streams remote bytes directly to persistent session
   files.
5. Session metadata contains indexes, filenames, byte counts, hashes, reserved Vault
   paths, and status. It never persists remote URLs, authorization headers, Feishu
   tokens, or the original document URL.
6. The companion continues while the popup is closed. A reopened popup reads session
   status and displays completed assets, bytes, speed, and failures.
7. When every asset is complete, the companion writes one asset at a time through
   Obsidian APIs, replaces opaque markers, and creates the final note. Failed or
   interrupted sessions can be requeued with refreshed short-lived URLs.

## Limits

- Up to 1,000 assets per session.
- Default image limit: 64 MiB.
- Default video or file limit: 4 GiB.
- Default session limit: 20 GiB.
- Persistent session lifetime: 24 hours after the latest activity.
- Download concurrency: three images or one large video at a time.
- Remote URLs must use HTTPS and match the existing Feishu/Lark media allowlist on
  every redirect.

## Compatibility

- Protocol version 1 stays unchanged.
- `GET /v1/health` adds capability names and resumable limits.
- Older companions without the resumable capability continue using
  `/v1/transactions`; that compatibility path retries one transient download failure.
- New clients select resumable sessions whenever the companion advertises the
  capability, including for a single locally saved image.
- Image mode and video/large-file mode are independent.
- Link-only video/file placeholders become portable source-document links and never
  enter a bridge session.
- Existing all-local users retain that behavior during settings migration; new
  installations default videos and large files to links.

## Failure handling

- A browser or popup closure does not cancel queued companion downloads.
- An Obsidian restart reloads completed session files. Expired URLs are not persisted;
  reopening the Feishu document refreshes and requeues missing assets.
- A failed asset is visible by index and can be retried without touching completed
  files.
- The final note is created only after every required asset completes.
- A failed Vault commit rolls back newly created attachments and retains staged
  session files for retry.

## Acceptance criteria

- The 269-image, 11-video test document can save all downloadable assets locally when
  both settings request it.
- The same document can save images locally while keeping all videos and large files
  as source links, without queuing those linked items.
- Closing and reopening the popup preserves visible progress.
- Restarting Obsidian after partial completion keeps completed assets resumable.
- No Base64 media, tenant token, App Secret, full document identifier, or persistent
  remote media URL is written to the note, companion metadata, or logs.
- Existing 49-image regression and all official Web Clipper tests still pass.
