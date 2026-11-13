import { App, MarkdownView, Modal, Notice, TFile } from 'obsidian';
import type { ChapterFolder } from '../settings';
import type { ChapterListSource } from '../components/EmbeddedManifest';
import { codeBlockButton, showCreateNotePopover } from '../components/CodeBlockCreateNote';
import { insertCodeBlockLink, removeCodeBlockLink, reorderCodeBlockLinks } from '../components/CodeBlockEdits';
import { parseCodeBlockLinks } from '../components/CodeBlockParser';
import { CodeBlockLinkSuggest } from '../components/CodeBlockLinkSuggest';

export class ChapterListModal extends Modal {
	private selected = 0;
	private busy = false;
	private closed = false;
	private list!: HTMLElement;
	private search!: HTMLInputElement;
	private suggest?: CodeBlockLinkSuggest;

	constructor(app: App, private lists: ChapterListSource[], private preferredFolder: () => ChapterFolder) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Edit chapter list');
		this.modalEl.addClass('book-chapter-list-modal');
		if (this.lists.length > 1) {
			const select = this.contentEl.createEl('select', { attr: { 'aria-label': 'Chapter list' } });
			for (const [index, entry] of this.lists.entries()) {
				const line = entry.raw.slice(0, entry.from).split('\n').length - 1;
				select.createEl('option', { value: String(index), text: `${entry.file.path} · ${line}` });
			}
			select.addEventListener('change', () => {
				this.selected = Number(select.value);
				this.renderRows();
			});
		} else {
			this.contentEl.createDiv({ cls: 'book-view-codeblock-suggest-path', text: this.lists[0]!.file.path });
		}
		this.search = this.contentEl.createEl('input', {
			attr: { type: 'search', placeholder: 'Find a link', 'aria-label': 'Find a link' },
		});
		this.list = this.contentEl.createDiv({ cls: 'book-view-codeblock-list' });
		this.search.addEventListener('input', () => this.renderRows());
		this.renderRows();
		this.search.focus();
	}

	onClose(): void {
		this.closed = true;
		this.suggest?.close();
		this.contentEl.empty();
	}

	private async save(entry: ChapterListSource, previous: string, body: string, row: number, action?: 'edit' | 'grip'): Promise<void> {
		if (this.busy || this.closed || entry.raw !== previous) throw new Error('Chapter list changed');
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file === entry.file && view.getMode() === 'source' &&
				view.editor.getValue() !== previous.replace(/\r\n/g, '\n')) {
				throw new Error('Chapter list has unsaved changes');
			}
		}
		const prefix = previous.slice(0, entry.from);
		const separator = body && !prefix.endsWith('\n') ? '\n' : '';
		const raw = prefix + separator + body + previous.slice(entry.to);
		if (raw === previous) return;
		this.busy = true;
		try {
			await this.app.vault.process(entry.file, (current) => {
				if (current !== previous) throw new Error('Chapter list changed');
				return raw;
			});
			const oldEnd = entry.to;
			const delta = raw.length - previous.length;
			for (const other of this.lists) {
				if (other.file !== entry.file) continue;
				other.raw = raw;
				if (other === entry) {
					other.from += separator.length;
					other.to += delta;
				} else if (other.from >= oldEnd) {
					other.from += delta;
					other.to += delta;
				}
			}
		} finally {
			this.busy = false;
		}
		if (!this.closed && this.lists[this.selected] === entry) {
			if (action === 'edit') this.search.value = '';
			this.renderRows(row, action);
		}
	}

	private apply(save: Promise<void>): void {
		void save.catch(() => new Notice('Could not save the chapter list. Reopen the editor to load the latest version.'));
	}

	private renderRows(active = -1, action?: 'edit' | 'grip'): void {
		this.suggest?.close();
		const scroll = this.list.scrollTop;
		this.list.empty();
		const entry = this.lists[this.selected]!;
		const previous = entry.raw;
		const body = previous.slice(entry.from, entry.to);
		const links = parseCodeBlockLinks(body, true);
		const query = this.search.value.trim().toLocaleLowerCase();
		let dragged = -1;
		let dropTarget: HTMLElement | undefined;
		const clearDrop = () => dropTarget?.removeClass('book-view-codeblock-drop-before', 'book-view-codeblock-drop-after');
		const move = (from: number, to: number, keyboard = false) => {
			const reordered = reorderCodeBlockLinks(body, from, to);
			this.apply(this.save(entry, previous, reordered, to, keyboard ? 'grip' : undefined));
		};
		const add = (row: HTMLElement, index: number, file: TFile | null) => {
			const button = codeBlockButton(row, 'Add link below', 'plus', 'book-view-codeblock-add');
			button.addEventListener('click', () => {
				if (this.busy) return;
				showCreateNotePopover(this.app, button, entry.file, file, this.preferredFolder(),
					() => !this.busy && !this.closed && entry.raw === previous,
					(link) => this.save(entry, previous, insertCodeBlockLink(body, index, link, entry.indent), index + 1),
					() => this.apply(this.save(entry, previous, insertCodeBlockLink(body, index, '[[]]', entry.indent), index + 1, 'edit')));
			});
		};
		if (!links.length) {
			const row = this.list.createDiv({ cls: 'book-view-codeblock-item', text: 'No links yet' });
			add(row, -1, null);
		}
		let shown = 0;
		let activeRow: HTMLElement | undefined;
		for (const [index, link] of links.entries()) {
			const file = link.target ? this.app.metadataCache.getFirstLinkpathDest(link.target, entry.file.path) : null;
			const label = link.display ?? file?.basename ?? (link.target || 'Empty link');
			if (query && !`${label} ${link.target}`.toLocaleLowerCase().includes(query)) continue;
			shown++;
			const row = this.list.createDiv({ cls: 'book-view-codeblock-item' });
			if (links.length > 1 && !query) {
				const grip = codeBlockButton(row, 'Move link (up or down arrow)', 'grip-vertical', 'book-view-codeblock-grip');
				grip.draggable = true;
				grip.addEventListener('dragstart', (event) => {
					if (!event.dataTransfer || this.busy) {
						event.preventDefault();
						return;
					}
					dragged = index;
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setData('application/x-book-view-link', String(index));
				});
				grip.addEventListener('dragend', () => { dragged = -1; clearDrop(); });
				grip.addEventListener('keydown', (event) => {
					if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
					event.preventDefault();
					move(index, index + (event.key === 'ArrowUp' ? -1 : 1), true);
				});
				const after = (event: DragEvent) => {
					const bounds = row.getBoundingClientRect();
					return event.clientY >= bounds.top + bounds.height / 2;
				};
				row.addEventListener('dragover', (event) => {
					if (dragged < 0) return;
					event.preventDefault();
					clearDrop();
					dropTarget = row;
					row.addClass(after(event) ? 'book-view-codeblock-drop-after' : 'book-view-codeblock-drop-before');
				});
				row.addEventListener('drop', (event) => {
					if (dragged < 0) return;
					event.preventDefault();
					const slot = index + (after(event) ? 1 : 0);
					move(dragged, slot > dragged ? slot - 1 : slot);
					dragged = -1;
					clearDrop();
				});
			}
			const button = row.createEl('button', {
				cls: 'book-chapter-list-link', text: label, attr: { type: 'button', title: link.target || label },
			});
			const startEditing = () => this.editRow(row, body.slice(link.offset, link.end), (value) => {
				const next = body.slice(0, link.offset) + value + body.slice(link.end);
				this.apply(this.save(entry, previous, next, index));
			});
			button.addEventListener('click', startEditing);
			const remove = codeBlockButton(row, 'Remove link', 'minus', 'book-view-codeblock-remove');
			remove.addEventListener('click', () => {
				if (this.busy) return;
				this.apply(this.save(entry, previous, removeCodeBlockLink(body, link), -1));
			});
			add(row, index, file?.extension === 'md' ? file : null);
			if (index === active) {
				activeRow = row;
				if (action === 'edit') startEditing();
				else row.addClass('book-view-codeblock-moved');
			}
		}
		if (query && !shown && links.length) this.list.createDiv({ text: 'No matching links' });
		this.list.scrollTop = scroll;
		activeRow?.scrollIntoView({ block: 'nearest' });
		if (action === 'grip') {
			activeRow?.querySelector<HTMLElement>('.book-view-codeblock-grip')?.focus({ preventScroll: true });
		}
	}

	private editRow(row: HTMLElement, original: string, commit: (value: string) => void): void {
		if (this.busy || row.hasClass('book-view-codeblock-editing')) return;
		this.suggest?.close();
		this.list.querySelector('.book-view-codeblock-editing')?.removeClass('book-view-codeblock-editing');
		this.list.querySelector('.book-view-codeblock-edit')?.remove();
		row.addClass('book-view-codeblock-editing');
		const input = row.createEl('input', {
			cls: 'book-view-codeblock-edit', value: original, attr: { type: 'text', 'aria-label': 'Chapter link' },
		});
		const finish = (save: boolean) => {
			if (!input.isConnected) return;
			suggest.close();
			row.removeClass('book-view-codeblock-editing');
			input.remove();
			if (!save) return;
			let value = input.value.trim();
			if (value && !parseCodeBlockLinks(value, true).length) value = `[[${value}]]`;
			const links = parseCodeBlockLinks(value || '[[]]', true);
			if (links.length !== 1 || links[0]?.offset !== 0 || links[0].end !== (value || '[[]]').length) {
				new Notice('Enter a single link or note name.');
				return;
			}
			commit(value || '[[]]');
		};
		const suggest = new CodeBlockLinkSuggest(this.app, input, () => finish(true));
		this.suggest = suggest;
		input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== 'Escape') return;
			event.stopPropagation();
			event.preventDefault();
			if (!suggest.isOpen()) finish(event.key === 'Enter');
		});
		input.addEventListener('blur', () => input.win.setTimeout(() => finish(false), 0));
		input.focus({ preventScroll: true });
		if (original === '[[]]') input.setSelectionRange(2, 2);
		else input.select();
	}
}
