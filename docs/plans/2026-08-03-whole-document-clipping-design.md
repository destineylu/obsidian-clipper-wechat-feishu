# Whole-document clipping design

## Goal

Add a one-click action that recognizes documentation sites, previews the page
count, clips every documentation page, and saves either a chapter folder with a
generated index or one merged Markdown note.

## Scope

The first release recognizes Sphinx sites through the version-local
`searchindex.js`. It constrains collection to the current origin and
documentation root, ignores duplicate and generated index pages, and caps a
bundle at 100 pages. Other documentation engines can be added behind the same
discovery interface later.

## User experience

The popup's secondary action menu contains **Clip entire documentation**. The
action discovers pages before writing anything and asks for confirmation with
the detected site title, documentation root, and page count. While collection
or writing is active the popup shows a progress panel and disables conflicting
actions.

When the paired Obsidian companion plugin advertises document-bundle support,
the default output is a folder containing one note per source page plus
`00 - Documentation index.md`. Nested Sphinx document names retain their folder
hierarchy. Existing same-path notes are overwritten, but unrelated or stale
files are never deleted.

If the companion plugin is unavailable, the extension explicitly reports the
fallback and saves one merged Markdown note through the existing Web Clipper
transport. This avoids rapid clipboard-based URI calls, which can associate a
chapter with the wrong clipboard contents.

## Architecture and data flow

1. `document-bundle` fetches and parses Sphinx `searchindex.js`, validates all
   document names, resolves same-origin page URLs, and returns a stable ordered
   manifest.
2. The collector fetches pages with bounded concurrency, runs the existing
   environment-agnostic clipping API with the active template, and creates
   chapter notes, index Markdown, and merged Markdown.
3. A generic document-bundle protocol is added to the existing authenticated
   loopback companion service. The service validates count, paths, duplicate
   targets, and total bytes before writing.
4. The Vault writer creates or overwrites all requested notes transactionally:
   on failure it restores modified notes and trashes notes created by the
   failed operation.
5. Popup integration owns confirmation, progress, cancellation-safe UI state,
   companion capability detection, and merged fallback.

## Safety and limits

- Same origin and current documentation-root URLs only.
- Maximum 100 pages and 20 MiB of Markdown per bundle.
- No directory traversal, absolute paths, control characters, or duplicate
  note targets.
- No automatic deletion of notes.
- At most three page fetches at once.
- A failed batch is rolled back by the companion writer.

## Verification

Unit tests cover Sphinx index parsing, unsafe URL rejection, manifest ordering,
index/merged output, server validation, and transactional Vault writes. The
repository type checks, targeted tests, full test suite, and Chrome/companion
production builds must pass.
