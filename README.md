# Book View

Renders a sequence of linked notes as a single scrollable document with a table of contents, lazy loading, and a script API for bulk text operations.

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

Book View exposes a global `window.BookView` API that external scripts (QuickAdd macros, Templater templates, custom plugins) can use to read and modify atom text.

### Setup

1. Open **Settings > Book View > Scripts**
2. Click **+ Add script**
3. Enter a label (e.g. "Replace text") and a command ID (e.g. `quickadd:macro:Replace text`)
4. Use **Find...** to search available commands

Once configured, right-click inside Book View or on a ToC heading to see the script in the context menu.

### Accessing the API

From any Obsidian script context (QuickAdd macro, Templater, etc.):

```typescript
const bv = (window as any).BookView;
```

Or in a typed context:

```typescript
declare const window: Window & { BookView?: BookViewAPI };
const bv = window.BookView;
if (!bv) return;
```

### Types

```typescript
interface Atom {
  text: string;      // one line from the note
  filePath: string;  // vault-relative path, e.g. "Notes/Page1.md"
  line: number;      // 0-based line number in the file
}

interface Change {
  filePath: string;  // target file path
  line: number;      // 0-based line number to replace
  newText: string;   // replacement text for that line
}
```

### Methods

#### `getSelectedText(): string`

Returns the text currently selected in the Book View DOM. If no text is selected, returns an empty string.

```typescript
const selected = bv.getSelectedText();
if (selected) {
  console.log("User selected:", selected);
}
```

#### `getAtomsUnderHeading(entryIndex?: number): Promise<Atom[]>`

Returns all atoms (one `Atom` per line per file) under a heading. Scope: from the given heading down to the next heading of equal or higher level.

- If `entryIndex` is omitted, uses the heading that was right-clicked.
- If no heading context exists, falls back to `getAllAtoms()`.

Each `Atom` represents **one line** of a file. Files are read via `vault.cachedRead()`.

```typescript
// Get atoms under the heading the user right-clicked
const atoms = await bv.getAtomsUnderHeading();

// Or specify an explicit ToC index
const atoms = await bv.getAtomsUnderHeading(3);

for (const atom of atoms) {
  console.log(`${atom.filePath}:${atom.line} -> ${atom.text}`);
}
```

#### `getAllAtoms(): Promise<Atom[]>`

Returns all atoms from every note linked in the current Book View manifest.

```typescript
const atoms = await bv.getAllAtoms();
console.log(`Total lines across all atoms: ${atoms.length}`);
```

#### `replaceText(changes: Change[], onApplied?: (paths: string[]) => void): void`

Opens a preview modal showing all proposed changes. The user reviews and clicks **Apply** to commit.

- `changes` — array of `Change` objects (one per line to replace)
- `onApplied` — optional callback receiving the list of file paths that were modified

After applying, Book View automatically re-renders affected sections.

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

### Context

When a script is triggered from the right-click menu, Book View sets a context that the API reads:

```typescript
// Available after a right-click menu trigger
bv.getSelectedText();  // text the user had selected (or "")
bv.getContext();       // { selection: string, entryIndex: number }
```

- `selection` — the DOM text selection at the time of right-click
- `entryIndex` — the ToC entry index if a heading was right-clicked (-1 otherwise)

### Full Example: QuickAdd Macro

Create a QuickAdd macro that replaces a word across all atoms under a heading:

```typescript
// In a QuickAdd User Script:
const bv = (window as any).BookView;
if (!bv) return;

const selected = bv.getSelectedText();
const replacement = await tp.system.prompt("Replace with:");

const atoms = await bv.getAtomsUnderHeading();

const changes = atoms
  .filter(a => a.text.includes(selected))
  .map(a => ({
    filePath: a.filePath,
    line: a.line,
    newText: a.text.replaceAll(selected, replacement),
  }));

bv.replaceText(changes);
```

### Full Example: Templater Template

```typescript
<%*
const bv = app.plugins.plugins["Book-View"]?.api
  ?? window.BookView;
if (!bv) return;

const atoms = await bv.getAllAtoms();
const count = atoms.filter(a => a.text.includes("TODO")).length;
tR += `Found ${count} lines containing "TODO"`;
%>
```

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build
npm run lint    # eslint
```

Build artifacts (`main.js`, `styles.css`, `manifest.json`) are copied to the vault plugin folder automatically.

## License

MIT
