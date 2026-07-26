import { App, Modal, TFile } from 'obsidian';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';

export class LiveEditModal extends Modal {
	private file: TFile;
	private editorView: EditorView | null = null;
	private onSaveCallback: () => void;

	constructor(app: App, file: TFile, onSaveCallback: () => void) {
		super(app);
		this.file = file;
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

		const editorContainer = contentEl.createDiv({ cls: 'book-edit-modal-editor' });

		const state = EditorState.create({
			doc: initialText,
			extensions: [
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown(),
				EditorView.lineWrapping,
				keymap.of([{
					key: 'Mod-Enter',
					run: () => {
						this.close();
						return true;
					},
				}]),
			],
		});

		this.editorView = new EditorView({
			state,
			parent: editorContainer,
		});
	}

	onClose(): void {
		if (this.editorView) {
			const newText = this.editorView.state.doc.toString();
			void this.app.vault.modify(this.file, newText).then(() => {
				this.onSaveCallback();
			});
			this.editorView.destroy();
			this.editorView = null;
		}
		this.contentEl.empty();
	}
}
