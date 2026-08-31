import { App, Modal, TFile } from 'obsidian';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { indentOnInput, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdownHighlight } from './theme';
import { tagHighlight } from './tags';
import { markHide } from './markers';

// ============================================================================
// TEMPORARILY DISABLED — manual CodeMirror popup editor
// ============================================================================
//
// This module is NOT currently imported/bundled. A detached native
// WorkspaceLeaf is used instead (see src/editor/NativeLeafPopover.ts), which
// gives the real Obsidian editor inside the popover — native Live Preview,
// themes, syntax highlighting, key bindings, and correct markdown marker
// hiding, with none of the hand-rolled decoration work below.
//
// The manual approach was being improved in the `feat/popup-editor-modal`
// branch: a custom CodeMirror 6 stack that re-created live-preview styling and
// marker hiding, because native-API solutions weren't being used at the time.
//
// What this stack consists of (all recoverable as-is):
//   - LiveEditModal (this file): a Modal hosting its own CodeMirror 6 view,
//     saving the whole file via app.vault.modify on Mod-Enter/Escape/close.
//   - src/editor/theme.ts        -> `markdownHighlight()` (obsidianMarkdownStyle):
//       CM6 syntax highlighting mapped onto Obsidian theme CSS variables
//       (--h1-*..--h6-*, --code-background, --text-accent, etc.), via
//       syntaxHighlighting(...) with tags from @lezer/highlight.
//   - src/editor/tags.ts         -> `tagHighlight()`: decorates `#tag` tokens
//       with the .cm-tag style (--tag-color / --tag-background).
//   - src/editor/markers.ts      -> `markHide()`: a ViewPlugin (MarkerDecorator)
//       that hides markdown markers (` ** * ~~ # > - [ ]()`` ) outside the
//       cursor, revealing them when the caret is inside the span. Structural
//       markers (ATXHeading/Blockquote/ListItem) reveal only on their own line.
//       Known unfixed issue: markers show as raw text on the first frame until
//       a click/scroll triggers an update, even after moving from
//       Decoration.replace to Decoration.mark + CSS display:none.
//   - styles.css: `.book-edit-modal-editor`, `.cm-tag`, `.bv-cm-hidden`.
//   - BookView.ts previously: `new LiveEditModal(this.app, file, line, cb)`.
//   - package.json deps added for it: @codemirror/autocomplete, @codemirror/
//     language, @codemirror/state, @codemirror/view, @codemirror/lang-markdown,
//     @lezer/highlight.
//
// To restore the manual editor:
//   1. Swap the BookView 'popup' branch back to `new LiveEditModal(...)`.
//   2. Re-add `import { LiveEditModal } from '../editor/LiveEditModal';`.
// The build only bundles what's imported, so this file can stay on disk.
// ============================================================================

export class LiveEditModal extends Modal {
	private file: TFile;
	private line: number;
	private onSaveCallback: () => void;
	private editorView: EditorView | null = null;

	constructor(app: App, file: TFile, line: number, onSaveCallback: () => void) {
		super(app);
		this.file = file;
		this.line = line;
		this.onSaveCallback = onSaveCallback;
	}

	async onOpen(): Promise<void> {
		const { contentEl, modalEl } = this;

		modalEl.addClass('book-edit-modal');

		contentEl.empty();

		contentEl.createEl('h3', {
			text: this.file.basename,
			cls: 'book-edit-modal-header',
		});

		const initialText = await this.app.vault.read(this.file);
		const initialLine = Math.max(0, Math.floor(this.line));

		const editorContainer = contentEl.createDiv({ cls: 'book-edit-modal-editor' });

		// Obsidian themes are driven by global CSS variables, so they apply
		// here for free. The theme below maps CodeMirror's own tokens onto
		// those variables so the popup editor reads as a native note editor
		// (monospace font, themed active line/selection/gutter) rather than a
		// bare textarea.
		const obsidianTheme = EditorView.theme({
			'&': {
				height: '100%',
				fontSize: 'var(--font-ui-small)',
				backgroundColor: 'var(--background-primary)',
				color: 'var(--text-normal)',
			},
			'.cm-content': {
				fontFamily: 'var(--font-monospace)',
				padding: '8px 12px',
				caretColor: 'var(--text-normal)',
			},
			'&.cm-focused': {
				outline: 'none',
			},
			'.cm-cursor': {
				borderLeftColor: 'var(--text-accent)',
			},
			'.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-selectionMatch': {
				backgroundColor: 'var(--background-modifier-hover)',
			},
			'.cm-activeLine': {
				backgroundColor: 'var(--background-secondary)',
			},
			'.cm-gutters': {
				backgroundColor: 'var(--background-secondary)',
				color: 'var(--text-muted)',
				borderRight: '1px solid var(--background-modifier-border)',
				fontFamily: 'var(--font-monospace)',
				fontSize: 'var(--font-ui-smaller)',
			},
			'.cm-scroller': {
				fontFamily: 'var(--font-monospace)',
			},
			'.cm-line': {
				padding: '0 4px',
			},
		});

		const state = EditorState.create({
			doc: initialText,
			extensions: [
				...markdownHighlight(),
				...tagHighlight(),
				...markHide(),
				markdown(),
				history(),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				obsidianTheme,
				EditorView.lineWrapping,
				keymap.of([
					...defaultKeymap,
					...historyKeymap,
					...closeBracketsKeymap,
					indentWithTab,
					{
						key: 'Mod-Enter',
						run: () => {
							this.saveAndClose();
							return true;
						},
					},
					{
						key: 'Escape',
						run: () => {
							this.saveAndClose();
							return true;
						},
					},
				]),
			],
		});

		this.editorView = new EditorView({
			state,
			parent: editorContainer,
		});

		// Force an immediate re-computation of decorations. CodeMirror skips
		// applying initial ViewPlugin decorations on the very first frame, so
		// hidden markdown markers (`, #, **) would otherwise show as raw text
		// until the first click/scroll triggers an update. An empty dispatch
		// triggers that update synchronously before the modal is displayed.
		this.editorView.dispatch({});

		// Jump to the target line once the editor has mounted and laid out, so
		// the go-to-line scroll lands even for long notes. CM lines are
		// 1-based; the caller's line is 0-based.
		window.requestAnimationFrame(() => {
			const view = this.editorView;
			if (!view) return;
			view.dispatch({
				selection: { anchor: view.state.doc.line(initialLine + 1).from },
				scrollIntoView: true,
			});
			view.focus();
		});
	}

	private saveAndClose(): void {
		if (!this.editorView) {
			this.close();
			return;
		}
		void this.app.vault.modify(this.file, this.editorView.state.doc.toString()).then(() => {
			this.onSaveCallback();
		});
		this.close();
	}

	onClose(): void {
		if (this.editorView) {
			this.editorView.destroy();
			this.editorView = null;
		}
		this.contentEl.empty();
	}
}
