# Book View

*Read a sequence of linked notes as a single, virtually merged document — with a unified table of contents.*

---

**Book-View** is a note virtualization plugin.

Book View renders a sequence of linked notes as a single, continuous long-form document with an automatically generated, unified Table of Contents. Designed for workflows built around atomic notes — such as TTRPG rulebooks, book chapters, or structured research — it lets you read through multiple files in one seamless view and quickly jump into editing individual notes using Ctrl + Double Click.

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
