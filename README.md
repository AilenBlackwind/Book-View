# Book View

*Read a sequence of linked notes as a single, virtually merged document — with a unified table of contents.*

---

**Book-View** is a note virtualization plugin. Native Obsidian embeds aren't suited for displaying dozens—let alone hundreds—of notes in a single continuous scroll via CSS snippets without causing lag. Not to mention that creating a unified table of contents for them usually requires various workarounds.

**This plugin** takes a note containing a list of links (one per line) and renders them as a single large document (a **Book**) in reading view, automatically generating a working table of contents from all headings across the linked notes. You can edit notes by simply pressing Ctrl + double-clicking anywhere in the book — this opens the standard Obsidian editor with the corresponding note in a separate window. Clicking back on the Book closes the editor.

===placeholder for a preview animation===

> [!warning] Status
> Book View is in active beta development. While safe for reading, please make sure you have backups (or File Recovery enabled) if you use experimental script-based batch editing features. Feel free to report any issues on GitHub!

---

## How to Use

1. In the note you want to turn into a Book, create a list of links formatted like this:

[[Note 1]]
[[Note 2]]
[[Note 3]]

===placeholder for a screenshot===

2. Open the Command Palette (`Ctrl/Cmd + P`) and run **Book View: Toggle View** (or add `book-view: true` to the frontmatter).
3. **Open Editor:** `Ctrl + Double Click` anywhere in the book to edit the corresponding note.

---

## Additional Features

* Customizable scroll speed in Book View.
* Ability to change the modifier key or set a custom key combination for editing notes.
* Scripting API that allows reading and modifying atomized text.
* Customizable dropdown menu for running script commands.

## Script API
[Script API](SCRIPT_API.md)