# Book View

Renders a sequence of linked notes as a single scrollable document with a table of contents, lazy loading, and a script API for bulk text operations.

## Status

This project is AI-assisted and under active development. It has plenty of minor bugs. Use at your own risk.

## Features

- Manifest-driven: a frontmatter property `book-view: true` activates the view
- Table of contents with scroll spy, nesting guides, and Markdown rendering
- Absolute-positioning layout with lazy section loading and height caching
- Wheel flick acceleration for trackpad/mouse scroll
- Alt/Ctrl+dblclick opens an atom in a popout window
- Script API for external tools (QuickAdd, Templater, etc.) to read and modify atom text

## Installation

Copy `main.js`, `styles.css`, and `manifest.json` to your vault:

```
<Vault>/.obsidian/plugins/Book-View/
```

Enable in **Settings > Community plugins**.

## Script API

Book View exposes a global `window.BookView` API that external scripts (QuickAdd macros, Templater templates, custom plugins) can use to read and modify atom text. For setup, types, methods, and examples, see [Script API](SCRIPT_API.md).

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build
npm run lint    # eslint
```

Build artifacts (`main.js`, `styles.css`, `manifest.json`) are copied to the vault plugin folder automatically.
