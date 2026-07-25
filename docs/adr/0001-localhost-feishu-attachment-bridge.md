# ADR-0001: Use a loopback companion for Feishu binary attachments

## Status

Accepted.

## Context

Feishu images, videos, and file attachments require authenticated API requests from
the browser extension. Passing images as Base64 inside one Markdown value causes
excessive memory use and can exceed browser, clipboard, and Obsidian note limits.
Downloading every video by default also consumes substantial Vault capacity. The
existing `obsidian://` handoff can create text notes but cannot stream binary
attachments.

The solution must keep official Web Clipper upgrade compatibility, preserve App ID
and App Secret inside the extension, limit transient media authorization to an
authenticated loopback channel, and provide a one-click desktop workflow.

## Decision

Add a Desktop-only Obsidian companion plugin that exposes an authenticated transaction
API on `127.0.0.1`. The browser extension downloads only the Feishu media categories
selected for local storage. It uploads raw bytes one asset at a time, or delegates
validated temporary media URLs to a resumable local session. The companion writes
attachments with Obsidian Vault APIs and commits the Markdown note after all required
local assets have reached a terminal state.

Image storage and video/large-file storage are separate policies:

- Images: links, legacy Base64, or companion binary attachments.
- Videos and large files: original Feishu links or companion binary attachments.

New installations keep videos and large files as links by default. Existing users
whose old image mode was the companion retain the previous all-local behavior until
they explicitly change the new attachment setting.

The plugin stores only a pairing-token hash. For resumable downloads, short-lived
media URLs and a tenant bearer token may cross the authenticated loopback bridge, but
remain memory-only and are never persisted in session metadata, notes, or logs. App ID
and App Secret never cross the bridge.

## Consequences

### Positive

- Removes Base64 expansion from the normal large-document path.
- Bounds extension memory to a small number of images.
- Produces portable attachment links inside the vault.
- Allows local images without forcing large videos into the vault.
- Preserves a one-click Add to Obsidian workflow.
- Keeps the custom integration behind narrow Feishu save hooks.

### Negative

- Requires installation and pairing of a second component.
- Works only in Obsidian Desktop.
- Adds a local server and transaction lifecycle that must be maintained.
- Daily-note behavior cannot be supported safely in the first version.

### Neutral

- Existing link-only and Base64 inline image modes remain available.
- Link-only attachments never enter a bridge transaction or resumable queue.
- The companion is developed in this repository but built as a separate artifact.

## Alternatives considered

- Native Messaging: rejected for first release because of native-host installation and
  browser-specific registration.
- ZIP export: rejected as the primary path because it is not one-click.
- Larger Base64 budgets: rejected because it worsens the core memory problem.

## References

- https://docs.obsidian.md/Plugins/Vault
- https://github.com/obsidianmd/obsidian-api
- `docs/plans/2026-07-25-feishu-attachment-bridge-design.md`
