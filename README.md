# Book View

*Read a sequence of linked notes as a single, virtually merged document — with a unified table of contents.*

---

Book View renders a sequence of linked notes as a single, continuous long-form document with an automatically generated, unified Table of Contents. Designed for workflows built around atomic notes — such as TTRPG rulebooks, book chapters, or structured research — it lets you read through multiple files in one seamless view and quickly jump into editing individual notes using **Ctrl/Cmd + Double-click**. This plugin can also be more convenient than regular embeddings at extremely large scales (1,000+ notes in one scroll).

===placeholder for a preview animation===

> [!WARNING]
> Book View is in active beta development. While safe for reading, please make sure you have backups (or File Recovery enabled) if you use experimental script-based batch editing features. Feel free to report any issues on GitHub!

---

## How to Use

1. In the note you want to turn into a Book, create a list of links formatted like this:

```markdown
[[Note 1]]
[[Note 2]]
[[Note 3]]
```
===placeholder for a screenshot===

2. Open the Command Palette (`Ctrl/Cmd + P`) and run **Book View: Toggle View** (or add `book-view: true` to the frontmatter).
3. **Open Editor:** `Ctrl/Cmd + Double-click` anywhere in the book to edit the corresponding note.

---

## Additional Features

* Customizable scroll speed in Book View.
* Ability to change the modifier key or set a custom key combination for editing notes.
* Scripting API that allows reading and modifying atomized text.
* Customizable dropdown menu for running script commands.

### Book-Specific CSS Snippets

A Book can carry its own CSS styling, separate from the rest of the vault:

1. Add `cssclasses` to the frontmatter of the Book's manifest note, for example:

```yaml
---
book-view: true
cssclasses: my-book
---
```

2. Create a CSS snippet (**Settings → Appearance → CSS snippets**) with rules scoped to that class:

```css
/* Dark theme */
.theme-dark .my-book {
    --h1-color: #ff7675;
    --h2-color: #fdcb6e;
    --h3-color: #55efc4;
    --h4-color: #81ecec;
    --h5-color: #74b9ff;
    --h6-color: #a29bfe;
}

/* Light theme */
.theme-light .my-book {
    --h1-color: #d63031;
    --h2-color: #e17055;
    --h3-color: #00b894;
    --h4-color: #0984e3;
    --h5-color: #6c5ce7;
    --h6-color: #2d3436;
}
```

3. Enable the snippet and (re)open the Book.

All classes from the manifest's `cssclasses` are applied to the book's root element, so every note in the book is styled, while notes outside the book are unaffected. The same classes are also applied to the popover editor (**Ctrl/Cmd + Double-click**), so scoped rules that match its DOM apply there too. Any class names work — `my-book` in the examples is just an example.

> [!NOTE]
> CSS snippets are loaded globally by Obsidian — only the selector keeps them book-local. Make sure every rule in a book-styling snippet starts with your scope class (e.g. `.my-book ...`); any rule without it will apply to the entire vault.

### Customizing the ToC Highlight Colors

The table of contents marks the active heading with a colored pill (background highlight) and accent-colored text. By default these follow Obsidian's accent color and switch automatically between dark and light themes. You can override them with a CSS snippet:

| Selector                   | What it controls                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.book-toc-highlight`      | The pill (background rectangle behind the active heading)                                                  |
| `.book-toc-item.is-active` | The active heading's text color                                                                            |
| `--bv-toc-highlight-color` | Custom property on `.book-toc-highlight` to override the pill color (falls back to `--interactive-accent`) |

Example — blue pill in light theme, purple in dark:

```css
body.theme-light .book-toc-highlight {
	--bv-toc-highlight-color: #3b82f6;
}

body.theme-light .book-toc-item.is-active {
	color: #2563eb;
}

body.theme-dark .book-toc-highlight {
	--bv-toc-highlight-color: #a78bfa;
}

body.theme-dark .book-toc-item.is-active {
	color: #c4b5fd;
}
```

Enable the snippet in **Settings → Appearance → CSS snippets**. To style only a specific book, scope the selectors under its `cssclasses` wrapper (see [Book-Specific CSS Snippets](#book-specific-css-snippets) above).

## Script API
[Script API](SCRIPT_API.md)