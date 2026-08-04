---
permalink: web-clipper/capture
aliases:
  - Obsidian Web Clipper/Capture web pages
---
Once you install the [[Introduction to Obsidian Web Clipper|Web Clipper]] browser extension, you can access it in several ways, depending on your browser:

1. The Obsidian icon in your browser toolbar.
2. Hotkeys, to activate the extension from your keyboard.
3. Context menu, by right-clicking the web page you are visiting.

To save a page to Obsidian click the **Add to Obsidian** button.

## Capture a page

When you open the extension, Web Clipper extracts data from the current web page following the settings in your [[Obsidian Web Clipper/Templates|template]]. You can create your own templates, and customize the output using [[variables]] and [[filters]].

By default Web Clipper attempts to intelligently extract only the main article content, excluding other elements on the page. However, you can override this behavior in the following ways:

- If a custom template is present it uses your template.
- If a selection is present, it uses the selection. You can use `Ctrl/Cmd+A` to select the entire page.
- If any [[Highlight web pages|highlights]] are present, it uses the highlights.

## Capture an entire documentation site

Web Clipper can collect a Sphinx documentation site (for example, a site built
with `sphinx` or `sphinx-rtd-theme`) from any page under that site's versioned
documentation root.

### Step-by-step

1. Open the documentation site in the browser. You can start from the home page
   or from any chapter page.
2. Open Web Clipper and wait for the page preview to finish. The extension
   detects Sphinx pages by their documentation metadata; the action is not shown
   on ordinary web pages.
3. Click the small **▼** on the right side of the purple **Add to Obsidian**
   button.
4. Choose **收藏整个说明文档** from the menu.
5. Review the detected title, page count and save mode in the confirmation
   dialog, then click **OK**. The progress panel reports discovery, collection
   and writing separately.

If the menu item is missing, refresh the documentation page and reopen the
extension. The current page must be served over `http://` or `https://`, and its
HTML must contain Sphinx metadata. Browser-internal pages, PDF viewers and
ordinary sites are not supported by this action.

### Where the notes go

For chapter mode, install and pair the desktop **Clipper Attachment Bridge**
plugin first. Web Clipper then writes one Markdown note per documentation page
and creates `00 - Documentation index.md` in the selected Vault and folder.

The index mirrors the site's navigation whenever possible:

- nested sidebar entries become nested Wiki links;
- navigation parent pages become folders for their child pages;
- caption/group entries become folder headings even when they are not pages;
- pages missing from the sidebar are placed under `Other pages`;
- if the site has no readable sidebar, Sphinx `docname` paths are used as a
  fallback hierarchy.

For example, a sidebar such as `Guide → Install → Advanced` becomes:

```text
Documentation/
├── 00 - Documentation index.md
└── Guide/
    └── Install/
        └── Advanced.md
```

The index links to those notes with relative Obsidian Wiki links. Re-running the
same collection overwrites notes with the same paths, so the documentation can
be refreshed safely. It does not delete unrelated notes or pages that have
disappeared from the website.

### Merged-note fallback

If the companion plugin is not paired, unavailable, connected to another Vault,
or too old to advertise document-bundle support, the confirmation dialog shows
**one merged Markdown note** instead of chapter mode. The note contains the
whole site in navigation order. Page titles become heading levels, and headings
inside each page are shifted underneath the page title without duplicating the
same title.

The initial implementation is limited to Sphinx sites, 100 source pages, three
concurrent page requests, and 20 MiB of Markdown for chapter-folder writes.
Only pages on the same origin and beneath the detected documentation root are
accepted. Images continue to use their original web URLs.

## Download images

Images are not automatically downloaded when you use Web Clipper. Instead, images link to their web-based URL. This saves space in your vault but it means the images will not be accessible offline, or if the URL stops working.

You can download images for any file in Obsidian using the [[Command palette|command]] named **Download attachments for current file**. This command can also be mapped to a hotkey in Obsidian.

## Hotkeys

Web Clipper includes keyboard shortcuts you can use to speed up your workflow. To change key mappings go to **Web Clipper Settings** → **General** and follow the instructions for your browser. Mappings can be changed for all browsers except Safari which does not support editing hotkeys.

| Action                  | macOS         | Windows/Linux  |
| ----------------------- | ------------- | -------------- |
| Open clipper            | `Cmd+Shift+O` | `Ctrl+Shift+O` |
| Quick clip              | `Opt+Shift+O` | `Alt+Shift+O`  |
| Toggle highlighter mode | `Opt+Shift+H` | `Alt+Shift+H`  |

## Interface functionality

The Web Clipper interface is divided into four sections:

1. **Header** where you can switch templates, turn on [[Highlight web pages|highlighting]], and access settings.
2. **Properties** shows the [[Properties|metadata]] extracted from the page that will be saved as [[Properties]] in Obsidian.
3. **Note content** that will be saved to Obsidian.
4. **Footer** allows you select the vault and folder, and add to Obsidian.

Header functionality includes:

- **Template** dropdown to switch between your saved [[Obsidian Web Clipper/Templates|templates]] added in Web Clipper settings.
- **More (...)** button to display page variables you can use in templates.
- **Highlighter** button to turn on [[Highlight web pages|highlighting]].
- **Cog** button to open Web Clipper settings.

Footer functionality includes:

- **Add to Obsidian** button to save data to Obsidian.
- **Vault** dropdown to switch between saved vaults added in Web Clipper settings.
- **Folder** field to define which folder to save to.
- **Interpreter** to run [[Interpret web pages|natural language prompts]] on the page.

