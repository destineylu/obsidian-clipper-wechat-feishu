# Documentation Hierarchy Design

## Goal

Preserve a Sphinx documentation site's navigation hierarchy in the generated
Obsidian index, note folders, and merged document headings.

## Design

The search index remains the source of truth for page completeness. After it is
parsed, the collector fetches the documentation root page and inspects common
Sphinx navigation containers. Matching same-root document links become an
ordered tree. Pages absent from the navigation remain available through a
fallback tree derived from their `docname` path, so navigation parsing can
never silently drop content.

Each navigation node records a document page and its children. The output
builder walks that tree once to assign ancestor folders, generate nested Wiki
links, and order the merged document. A parent page stays in its current folder
while its children are written below a folder named after the parent. The root
`index` page does not create a duplicate top-level folder.

The merged document uses the navigation depth for page headings and normalizes
the headings inside each page. A leading page-title heading is removed, then
remaining headings are shifted below the page heading while fenced code blocks
are left untouched. Heading levels are capped at six.

If no usable navigation tree is found, output falls back to the current
`docname` hierarchy. Duplicate links, cycles, external URLs, generated Sphinx
pages, and links outside the documentation root are ignored.

## Verification

Unit fixtures cover classic Sphinx nested lists, flat navigation, missing
pages, duplicate links, folder paths, nested Wiki indexes, and Markdown heading
normalization. The full test suite and Chrome production build must pass, then
the existing CDP browser session is reloaded without starting a browser.
