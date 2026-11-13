import { App, Notice, setIcon, TFile } from 'obsidian';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { CHAPTER_FOLDER_OPTIONS, type ChapterFolder } from '../settings';
import { uniqueMarkdownPath } from '../utils/uniquePath';

export function codeBlockButton(row: HTMLElement, label: string, icon: string, cls: string): HTMLButtonElement {
	const button = row.createEl('button', {
		cls: ['clickable-icon', 'book-view-codeblock-action', cls],
		attr: { type: 'button', 'aria-label': label, title: label },
	});
	setIcon(button, icon);
	button.addEventListener('mousedown', (event) => {
		event.stopPropagation();
	});
	return button;
}

export function showCreateNotePopover(
	app: App,
	button: HTMLButtonElement,
	listFile: TFile,
	chapter: TFile | null,
	preferred: ChapterFolder,
	canInsert: () => boolean,
	insertLink: (link: string) => void | Promise<void>,
	insertPlaceholder: () => void,
): void {
	const row = button.parentElement;
	if (!row || row.querySelector('.book-view-create-note')) return;
	const folders: Record<ChapterFolder, string | undefined> = {
		list: listFile.parent?.path ?? '/',
		chapter: chapter?.parent?.path,
		root: '/',
	};
	const form = row.createEl('form', { cls: 'book-view-create-note' });
	const native = typeof form.showPopover === 'function';
	if (native) form.setAttribute('popover', 'auto');
	form.addEventListener('click', (event) => event.stopPropagation());
	form.addEventListener('mousedown', (event) => event.stopPropagation());
	const name = form.createEl('input', {
		attr: { type: 'text', placeholder: 'Note name', 'aria-label': 'Note name', required: '' },
	});
	const folder = form.createEl('select', { attr: { 'aria-label': 'Destination folder' } });
	const choices = Object.keys(CHAPTER_FOLDER_OPTIONS) as ChapterFolder[];
	if (choices.includes(preferred)) {
		choices.splice(choices.indexOf(preferred), 1);
		choices.unshift(preferred);
	}
	for (const choice of choices) {
		const path = folders[choice];
		const label = CHAPTER_FOLDER_OPTIONS[choice];
		const option = folder.createEl('option', { value: choice, text: path ? `${label} (${path})` : label });
		option.disabled = path === undefined;
	}
	folder.selectedIndex = choices.findIndex((choice) => folders[choice] !== undefined);
	const actions = form.createDiv({ cls: 'book-view-create-note-actions' });
	const empty = actions.createEl('button', { text: 'Insert empty link', attr: { type: 'button' } });
	const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
	const submit = actions.createEl('button', { text: 'Create note', cls: 'mod-cta', attr: { type: 'submit' } });
	empty.addEventListener('click', () => {
		form.remove();
		insertPlaceholder();
	});
	cancel.addEventListener('click', () => {
		form.remove();
		button.focus();
	});
	if (native) {
		form.addEventListener('toggle', () => {
			if (!form.matches(':popover-open')) form.remove();
		});
		form.showPopover();
		void computePosition(button, form, {
			strategy: 'fixed', placement: 'bottom-end',
			middleware: [offset(4), flip(), shift({ padding: 8 })],
		}).then(({ x, y }) => {
			form.style.left = `${x}px`;
			form.style.top = `${y}px`;
		});
	}
	name.focus();
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		if (submit.disabled) return;
		const basename = name.value.trim().replace(/\.md$/i, '').trim();
		const directory = folders[folder.value as ChapterFolder];
		if (!basename || /^[.]+$/.test(basename) || /[\\/:*?"<>|[\]#^\r\n]/.test(basename)) {
			new Notice('Enter a valid note name without a path or link characters.');
			return;
		}
		if (!directory || /[|[\]#^\r\n]/.test(directory)) {
			new Notice('Choose a folder that can be used in a chapter link.');
			return;
		}
		if (!canInsert()) {
			new Notice('The chapter list changed. Reopen the form to try again.');
			form.remove();
			return;
		}
		const path = uniqueMarkdownPath(app.vault, directory === '/' ? `${basename}.md` : `${directory}/${basename}.md`);
		submit.disabled = true;
		empty.disabled = true;
		void app.vault.create(path, '').then(async (file) => {
			try {
				await insertLink(`[[/${file.path}]]`);
			} catch {
				new Notice(`Created ${file.path}. The chapter list changed before its link could be inserted.`);
			}
			form.remove();
		}, (error: unknown) => {
			new Notice(`Could not create the note. ${error instanceof Error ? error.message : String(error)}`);
			submit.disabled = false;
			empty.disabled = false;
		});
	});
}
