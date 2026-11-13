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

## Shared chapter lists

Keep a chapter list in a separate note, for example `Shared chapters.md`:

```markdown
[[Chapter 1]]
[[Chapter 2]]
```

Embed it in any number of book notes:

```markdown
---
book-view: true
---
![[Shared chapters]]
```

Book View expands the list into chapters at the embed's position. Editing the shared list updates every open book that uses it. The list note needs no `book-view` property. Nested embeds, Markdown note embeds, heading embeds (`![[Shared chapters#Part]]`) and block embeds (`![[Shared chapters#^list]]`) are supported. Relative links resolve from the note containing them; repeated chapters appear once, and cyclic embeds stop safely. Image and other attachment embeds do not become chapter lists. Ordinary chapter links keep their usual behavior.

## Additional Features

* Customizable scroll speed in Book View.
* Ability to change the modifier key or set a custom key combination for editing notes.
* Scripting API that allows reading and modifying atomized text.
* Customizable dropdown menu for running script commands.
* Right-click a table of contents heading and select **Copy section** to copy its Markdown and nested subsections, across linked notes, up to the next heading of the same or higher level. Note properties are excluded; no manuscript file is created.

**Create book** saves a new manifest and excludes existing book manifests from its chapter list. If the filename is taken, it adds a numbered suffix such as `(2)`; existing files are preserved. **Collect manuscript from linked notes** saves a new export alongside the source book and uses the same naming rule. Run it while the book or its table of contents is active; the exported manuscript opens in a new tab.

**Apply buffer changes** keeps the buffer when any section conflicts or is missing. Successfully applied sections can be retried safely; the buffer is moved to trash only after all mapped sections have been applied.

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

The table of contents marks the active heading with a colored pill (background highlight) and accent-colored text. By default these follow Obsidian's accent color and switch automatically between dark and light themes.

ToC rows live inside a shadow root, so document selectors cannot reach them — you cannot style `.bv-toc-highlight` directly anymore. Instead, customize through variables, which inherit through the shadow boundary. Set them on any ancestor of the ToC panel, typically the book's root element (see [Book-Specific CSS Snippets](#book-specific-css-snippets) above):

| Variable | Controls |
| --- | --- |
| `--bv-toc-highlight-color` | The pill color (falls back to `--interactive-accent`) |
| `--bv-toc-active-color` | The active heading's text color (falls back to `--text-accent`) |

Example — blue pill in light theme, purple in dark:

```css
.my-book {
	--bv-toc-highlight-color: #3b82f6;
	--bv-toc-active-color: #2563eb;
}

body.theme-dark .my-book {
	--bv-toc-highlight-color: #a78bfa;
	--bv-toc-active-color: #c4b5fd;
}
```

Enable the snippet in **Settings → Appearance → CSS snippets**. To style only a specific book, scope the selectors under its `cssclasses` wrapper (see [Book-Specific CSS Snippets](#book-specific-css-snippets) above).

## Script API
[Script API](SCRIPT_API.md)

## Diagnosing intermittent slow startup

Enable **Settings → Book View → General → Startup diagnostics**, then fully restart Obsidian. This setting is off by default. Each launch records the first 60 seconds after Book View loads and keeps the latest 20 reports in `startup-diagnostics.json` inside this plugin's folder. Reloading the plugin in an already running app is labelled separately from a startup.

The reports include timings for tab restoration, caller stacks, workspace readiness, pending operations, event loop gaps, and errors. Book View separately measures the inherited file-restoration step, pane-size wait, metadata wait, and book loading. The recorder temporarily observes the public `WorkspaceLeaf.setViewState` method and restores it after recording. It does not delay restoration to wait for layout readiness. Recording begins after Book View's settings load, so it cannot see initialization or earlier plugin activity.

No note contents or tab file paths are added to the report. Error messages and caller stacks may contain paths or details from Obsidian or other plugins; review reports before sharing them. Everything stays inside the vault until you choose to copy a report. There are no network requests.

After a slow launch, run **Book View: Copy startup reports** and copy Obsidian's **Startup time** report using the stopwatch in **Settings → General → Advanced**. The startup reports remain available across restarts. For comparison, change only Homepage's **Open on startup** setting, keep the workspace comparable, and collect reports with that setting both on and off. A successful run alone does not rule out an intermittent problem; a pending operation or plugin caller is a lead, not proof of responsibility. Disable startup diagnostics after the investigation and restart Obsidian; saved reports remain available in the plugin folder and can be deleted there.
