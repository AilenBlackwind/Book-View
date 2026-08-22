# Script API

Book View exposes a global `window.BookView` API that external scripts (QuickAdd macros, Templater templates, custom plugins) can use to read and modify atom text.

## Setup

1. Open **Settings > Book View > Context menus**
2. Click **+ add profile** — each profile is an independent right-click menu with its own modifier shortcut (Alt/Ctrl/Shift/Meta)
3. Inside the profile, click **+ add script**
4. Enter a label (e.g. "Replace text") and a command ID (e.g. `quickadd:macro:replace-text`)
5. Use **Find...** to search available commands

Once configured, right-click inside Book View **with the profile's modifier combination** to see its scripts. Right-clicking a heading inside the book captures the ToC entry context used by `getAtomsUnderHeading()`.

## Accessing the API

Two equivalent ways — use whichever fits your script context:

```typescript
// Canonical Obsidian plugin access (typed)
const bv = app.plugins.plugins["book-view"]?.api;

// Global alias (untyped, works everywhere)
const bv = (window as any).BookView;
```

Both point to the same `BookViewAPI` instance.

## Types

```typescript
interface Atom {
  text: string;      // one line from the note
  filePath: string;  // vault-relative path, e.g. "Notes/Page1.md"
  line: number;      // 0-based line number in the file
}

interface Change {
  filePath: string;  // target file path
  line: number;      // 0-based line number to replace
  newText: string;   // replacement text for that line (can contain \n for multi-line)
}

interface TocEntryInfo {
  index: number;     // ToC entry index (usable in getAtomsUnderHeading)
  title: string;     // heading text
  level: number;     // heading level (1-6)
  filePath: string;  // vault-relative path of the containing note
}
```

> **Note:** an "Atom" represents **one line** of text across the merged book document — not an entire note. This per-line model lets scripts target exact positions within files.

## Methods

### `getSelectedText(): string`

Returns the selected text at trigger time.

- When triggered from the right-click menu: returns the captured selection snapshot.
- When triggered from a hotkey or palette: falls back to reading the live DOM selection (`window.getSelection()`).

```typescript
const selected = bv.getSelectedText();
if (selected) {
  console.log("User selected:", selected);
}
```

### `getToc(): TocEntryInfo[]`

Returns the flat ToC of the active book in render order. Use the returned `index` to call `getAtomsUnderHeading(index)` programmatically (e.g. from a hotkey or QuickAdd suggester).

```typescript
const toc = bv.getToc();
for (const entry of toc) {
  console.log(`[${entry.index}] ${"#".repeat(entry.level)} ${entry.title} (${entry.filePath})`);
}
```

### `getFilePaths(): string[]`

Returns the file paths of all notes linked in the current Book View, in render order. Cheaper than `getAllAtoms()` when only paths are needed.

```typescript
const paths = bv.getFilePaths();
console.log(`Book contains ${paths.length} notes`);
```

### `getAtomsUnderHeading(entryIndex?: number): Promise<Atom[]>`

Returns all atoms (one `Atom` per line per file) under a heading. Scope: from the given heading down to the next heading of equal or higher level.

- If `entryIndex` is omitted, uses the heading that was right-clicked.
- If no heading context exists, falls back to `getAllAtoms()`.

Each `Atom` represents **one line** of a file. Files are read via `vault.cachedRead()`.

```typescript
// Get atoms under the heading the user right-clicked
const atoms = await bv.getAtomsUnderHeading();

// Or specify an explicit ToC index (from getToc())
const atoms = await bv.getAtomsUnderHeading(3);

for (const atom of atoms) {
  console.log(`${atom.filePath}:${atom.line} -> ${atom.text}`);
}
```

### `getAllAtoms(): Promise<Atom[]>`

Returns all atoms from every note linked in the current Book View manifest.

```typescript
const atoms = await bv.getAllAtoms();
console.log(`Total lines across all atoms: ${atoms.length}`);
```

### `replaceText(changes: Change[], onApplied?: (paths: string[]) => void): void`

Opens a preview modal showing all proposed changes. The user reviews and clicks **Apply** to commit.

> **For safety, replaceText always requires user confirmation through the preview modal** — there is no silent mode. This is intentional.

- `changes` — array of `Change` objects (one per line to replace)
- `onApplied` — optional callback receiving the list of file paths that were modified
- Changes are applied in reverse line order per file, so multi-line replacements (`newText` containing `\n`) do not shift subsequent edit targets
- After applying, Book View automatically re-renders affected sections

```typescript
const atoms = await bv.getAtomsUnderHeading();

const changes: Change[] = atoms
  .filter(a => a.text.includes("old term"))
  .map(a => ({
    filePath: a.filePath,
    line: a.line,
    newText: a.text.replace("old term", "new term"),
  }));

bv.replaceText(changes, (appliedPaths) => {
  console.log("Modified files:", appliedPaths);
});
```

## Context

When a script is triggered from the right-click menu, Book View sets a context that the API reads:

```typescript
// Available after a right-click menu trigger
bv.getSelectedText();  // text the user had selected (or "")
bv.getContext();       // { selection: string, entryIndex: number }
```

- `selection` — the DOM text selection at the time of right-click
- `entryIndex` — the ToC entry index if a heading was right-clicked (-1 otherwise)

## Full Example: QuickAdd Macro

Create a QuickAdd macro that replaces a word across all atoms under a heading chosen by the user:

```typescript
// In a QuickAdd macro user script, `params` provides `app`, `quickAddApi`, `obsidian`:
const bv = (window as any).BookView;
if (!bv) return;

// Let the user pick a section programmatically
const toc = bv.getToc();
const picked = await quickAddApi.suggester(
  (entry) => `${"#".repeat(entry.level)} ${entry.title}`,
  toc,
);
if (!picked) return;

const selected = bv.getSelectedText() || "TODO";
const replacement = await quickAddApi.inputPrompt("Replace with:");

const atoms = await bv.getAtomsUnderHeading(picked.index);

const changes = atoms
  .filter(a => a.text.includes(selected))
  .map(a => ({
    filePath: a.filePath,
    line: a.line,
    newText: a.text.replaceAll(selected, replacement),
  }));

bv.replaceText(changes);
```

## Full Example: Templater Template

```typescript
<%*
const bv = app.plugins.plugins["book-view"]?.api
  ?? window.BookView;
if (!bv) return;

const paths = bv.getFilePaths();
const count = paths.length;
tR += `Book contains ${count} notes`;
%>
```
