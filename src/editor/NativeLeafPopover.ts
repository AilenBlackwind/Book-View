import { App, MarkdownView, Modal, TFile, WorkspaceLeaf } from 'obsidian';

/**
 * Popover editor that reuses Obsidian's real editor by embedding a fully
 * detached `WorkspaceLeaf` (created via the private constructor) inside the
 * modal. This gives us native Live Preview — themes, syntax highlighting,
 * callouts, key bindings, and Obsidian's own markdown marker hiding — with no
 * custom CodeMirror stack, no separate popout window, and no open note on
 * screen required.
 *
 * Caveats:
 * - `new (WorkspaceLeaf as any)(this.app)` uses a private constructor (the
 *   public API only exposes `getLeaf()`), so this may break on future Obsidian
 *   versions. If it throws, fall back to the manual `LiveEditModal` stack or
 *   to `openPopoutLeaf()`.
 * - Save semantics differ from the manual editor: the native leaf is backed by
 *   a real vault file, and Obsidian persists it itself (auto-save). On close we
 *   just notify the caller to re-render; we do not force a `vault.modify`.
 */
export class NativeLeafPopover extends Modal {
	private file: TFile;
	private line: number;
	private hideFrontmatter: boolean;
	private onSaveCallback: () => void;
	private leaf: WorkspaceLeaf | null = null;

	constructor(app: App, file: TFile, line: number, hideFrontmatter: boolean, onSaveCallback: () => void) {
		super(app);
		this.file = file;
		this.line = line;
		this.hideFrontmatter = hideFrontmatter;
		this.onSaveCallback = onSaveCallback;
	}

	async onOpen(): Promise<void> {
		const { contentEl, modalEl } = this;

		modalEl.addClass('book-edit-modal');
		if (this.hideFrontmatter) {
			modalEl.addClass('hide-frontmatter');
		}

		// Hide the modal's close button directly rather than relying only on
		// CSS selectors, which can miss the real element depending on the
		// Obsidian version's DOM structure.
		modalEl.querySelector('.modal-close-button')?.addClass('bv-close-hidden');

		this.contentEl.empty();

		contentEl.createEl('h3', {
			text: this.file.basename,
			cls: 'book-edit-modal-header',
		});

		const editorContainer = contentEl.createDiv({ cls: 'book-native-leaf-editor' });

		// Private constructor: creates a leaf not attached to a workspace tab.
		// Wrap in `as any` to bypass the private accessor.
		let leaf: WorkspaceLeaf;
		try {
			leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(this.app);
		} catch {
			// Constructor unavailable on this Obsidian version — safe fallback.
			this.close();
			return;
		}

		this.leaf = leaf;

		await leaf.setViewState({
			type: 'markdown',
			state: {
				file: this.file.path,
				mode: 'source',
				cursor: { line: this.line, ch: 0 },
				// `frontmatter:false` hides the YAML block in the edit view.
				frontmatter: !this.hideFrontmatter,
			},
		});

		const viewEl = leaf.view?.containerEl;
		if (!viewEl) {
			leaf.detach();
			this.close();
			return;
		}
		editorContainer.appendChild(viewEl);

		// Focus the native editor once laid out, and scroll to the line.
		window.requestAnimationFrame(() => {
			const view = leaf.view instanceof MarkdownView ? leaf.view : (leaf.view as MarkdownView | undefined);
			const editor = view?.editor;
			if (editor) {
				editor.setCursor({ line: Math.max(0, this.line), ch: 0 });
				editor.scrollIntoView({ from: editor.getCursor(), to: editor.getCursor() }, true);
				editor.focus();
			}
		});
	}

	onClose(): void {
		if (this.leaf) {
			this.leaf.detach();
			this.leaf = null;
		}
		this.contentEl.empty();
		// The native leaf persists the file itself; just let the book re-render.
		this.onSaveCallback();
	}
}
