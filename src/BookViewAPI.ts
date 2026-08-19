import { App, Modal, Notice, TFile } from 'obsidian';
import type { TocEntry } from './toc/entries';

export interface Atom {
	text: string;
	filePath: string;
	line: number;
}

export interface Change {
	filePath: string;
	line: number;
	newText: string;
}

interface ScriptContext {
	selection: string;
	entryIndex: number;
}

class ReplacePreviewModal extends Modal {
	private changes: Change[];
	private onConfirm: () => void;

	constructor(app: App, changes: Change[], onConfirm: () => void) {
		super(app);
		this.changes = changes;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('book-replace-preview');

		this.scope.register([], "Enter", () => {
			this.onConfirm();
			this.close();
		});

		contentEl.createEl('h3', { text: `Replace in ${this.changes.length} location(s)` });

		const list = contentEl.createDiv({ cls: 'book-replace-list' });

		for (const change of this.changes) {
			const item = list.createDiv({ cls: 'book-replace-item' });
			const file = this.app.vault.getFileByPath(change.filePath);
			item.createDiv({
				cls: 'book-replace-file',
				text: `${file?.basename ?? change.filePath}:${change.line}`,
			});
			item.createEl('pre', { cls: 'book-replace-new', text: change.newText });
		}

		const btnRow = contentEl.createDiv({ cls: 'book-replace-buttons' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.onclick = () => this.close();
		const applyBtn = btnRow.createEl('button', { text: `Apply (${this.changes.length})`, cls: 'mod-cta' });
		applyBtn.onclick = () => {
			this.onConfirm();
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class BookViewAPI {
	private app: App;
	private context: ScriptContext = { selection: '', entryIndex: -1 };
	private findActiveBookView: () => import('./views/BookView').BookView | null;

	constructor(
		app: App,
		findActiveBookView: () => import('./views/BookView').BookView | null,
	) {
		this.app = app;
		this.findActiveBookView = findActiveBookView;
	}

	setContext(ctx: Partial<ScriptContext>): void {
		this.context = { ...this.context, ...ctx };
	}

	getContext(): ScriptContext {
		return { ...this.context };
	}

	getSelectedText(): string {
		return this.context.selection;
	}

	/** ToC entries of the active book, resolved through the coordinator (the
	 *  BookView no longer owns a ToC controller since the sidebar spike). */
	private getEntries(): TocEntry[] {
		return this.findActiveBookView()?.plugin?.tocCoordinator?.getEntries() ?? [];
	}

	async getAtomsUnderHeading(entryIndex?: number): Promise<Atom[]> {
		const idx = entryIndex ?? this.context.entryIndex;
		if (idx < 0) return this.getAllAtoms();
		if (!this.findActiveBookView()) return [];

		const entries = this.getEntries();
		if (idx >= entries.length) return [];

		const clicked = entries[idx];
		if (!clicked) return [];

		const level = clicked.level;
		let endIndex = entries.length;
		for (let i = idx + 1; i < entries.length; i++) {
			const e = entries[i];
			if (e && e.level <= level) {
				endIndex = i;
				break;
			}
		}

		const scopeEntries = entries.slice(idx, endIndex);
		const uniquePaths = [...new Set(scopeEntries.map((e) => e.file.path))];
		return this.readAtomsFromPaths(uniquePaths);
	}

	async getAllAtoms(): Promise<Atom[]> {
		const bv = this.findActiveBookView();
		if (!bv) return [];
		const paths = bv.getCurrentFiles().map((f) => f.path);
		return this.readAtomsFromPaths(paths);
	}

	private async readAtomsFromPaths(paths: string[]): Promise<Atom[]> {
		const atoms: Atom[] = [];
		for (const filePath of paths) {
			const file = this.app.vault.getFileByPath(filePath);
			if (!(file instanceof TFile)) continue;
			const content = await this.app.vault.cachedRead(file);
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line !== undefined) {
					atoms.push({ text: line, filePath, line: i });
				}
			}
		}
		return atoms;
	}

	replaceText(changes: Change[], onApplied?: (paths: string[]) => void): void {
		if (changes.length === 0) {
			new Notice('No changes to apply');
			return;
		}

		new ReplacePreviewModal(this.app, changes, () => {
			void this.applyChanges(changes, onApplied);
		}).open();
	}

	private async applyChanges(changes: Change[], onApplied?: (paths: string[]) => void): Promise<void> {
		const byFile = new Map<string, Change[]>();
		for (const change of changes) {
			const list = byFile.get(change.filePath) ?? [];
			list.push(change);
			byFile.set(change.filePath, list);
		}

		const appliedPaths: string[] = [];
		for (const [filePath, fileChanges] of byFile) {
			const file = this.app.vault.getFileByPath(filePath);
			if (!(file instanceof TFile)) continue;

			const content = await this.app.vault.cachedRead(file);
			const lines = content.split('\n');

			for (const change of fileChanges) {
				if (change.line >= 0 && change.line < lines.length) {
					lines[change.line] = change.newText;
				}
			}

			await this.app.vault.modify(file, lines.join('\n'));
			appliedPaths.push(filePath);
		}

		onApplied?.(appliedPaths);
		new Notice(`Applied: ${appliedPaths.length} file(s)`);
	}
}
