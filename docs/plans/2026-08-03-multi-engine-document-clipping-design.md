# Multi-engine documentation clipping design

## Goal

Extend whole-document clipping from Sphinx-only sites to the current-language
documentation collection on Claude Platform and Google Gemini API docs while
preserving the existing Sphinx behavior.

## Discovery adapters

Documentation discovery is provided through adapters that produce one common
manifest. The Sphinx adapter keeps `searchindex.js` as its completeness source.
The Claude adapter reads the official root `llms.txt`, follows only links under
the current locale root, and prefers direct Markdown pages. The Google DevSite
adapter reads every sitemap shard, keeps canonical Gemini API documentation
URLs for the current locale, and clips their HTML.

Discovery never recursively follows arbitrary page links. Every accepted page
must use HTTP(S), remain on the approved origin and documentation root, and
have a stable source URL. Navigation or URL paths provide the output hierarchy.

## Save modes

Collections below 100 pages may use the existing merged-note fallback when the
Companion is unavailable. Larger collections require a paired Companion and
are written as multiple notes plus an index. Images remain remote links.

Companion writes are split into batches of at most 50 notes and 10 MiB. Each
batch is transactional, while completed batches survive later failures.
Persistent collection state records source URLs, generated note paths, hashes,
completed pages and failures so collection can resume after interruption.

## Ownership and updates

Each collection has a stable ID derived from its canonical root and locale.
The Companion stores a private manifest mapping source URLs to generated note
paths. Existing paths are overwritten only when that manifest proves they were
created by the same collection. User-created conflicts receive unique paths.
Unchanged hashes are skipped. Removed upstream pages and unrelated notes are
never deleted.

## Error handling and verification

Index or locale ambiguity stops before writes. Individual page failures are
recorded while other pages continue. Transient 429 and 5xx responses receive
bounded backoff. Cross-root redirects and authentication pages are rejected.

Tests cover Sphinx compatibility, Claude indexes, Google sitemap shards,
locale filtering, canonical de-duplication, safe ownership, batching, rollback,
resume, unchanged pages and stale-page retention. Final verification includes
both TypeScript projects, full tests, Chrome and Companion builds, and the
existing Chrome session on port 19222.
