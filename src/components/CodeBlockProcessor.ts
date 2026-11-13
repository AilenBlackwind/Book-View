import { App, Editor, MarkdownPostProcessorContext, MarkdownView, Notice } from 'obsidian';
import { parseCodeBlockLinks } from './CodeBlockParser';
import { CodeBlockLinkSuggest } from './CodeBlockLinkSuggest';
import { insertCodeBlockLink, locateCodeBlock, reorderCodeBlockLinks } from './CodeBlockEdits';
import { codeBlockButton, showCreateNotePopover } from './CodeBlockCreateNote';
import type { ChapterFolder } from '../settings';

/**
 * Register a ```book-view code block processor that replaces the raw fenced
 * block with a styled list of links.  Obsidian calls the handler once per
 * code block instance, giving us the source text and a container element.
 *
 * The rendered list is purely cosmetic — the actual link extraction for the
 * book's section list is handled separately in ManifestParser via the raw
 * content of the manifest file.  This processor exists so the block is
 * human-readable when editing or previewing the manifest note.
 *
 * In Live Preview the block is not directly editable (the processor owns the
 * rendered DOM, so Obsidian can't route a click to the underlying source
 * line).  To keep it editable we intercept plain clicks on a rendered row and
 * open a small inline editor for that row's source line.  The whole block is
 * never opened, avoiding Obsidian's behavior of swapping the rendered list
 * back to the raw fenced block and parking the scroller at its bottom.  In
 * source/raw mode the processor does not run, so the block renders as an
 * ordinary code block and behaves as usual.
 */

/** The single active inline row-editor, if any. Only one row of any rendered
 *  block is edited at a time; opening another closes the previous one. */
let activeInlineEditor: {
	item: HTMLElement;
	input: HTMLInputElement;
	editor: Editor;
	line: number;
	start: number;
	original: string;
	suggest: CodeBlockLinkSuggest;
} | null = null;

/** Remove the inline editor from its row, restoring the original rendered
 *  content (the hidden link element). If `save` is set, write the input's
 *  text back to the source line being edited via `editor.replaceRange`, so
 *  Live Preview re-renders the block in place — the cursor never enters the
 *  block, so Obsidian's "swap to the whole code block for editing + scroll
 *  to its bottom" never triggers. */
function closeInlineEditor(save: boolean): void {
	const active = activeInlineEditor;
	if (!active) return;
	activeInlineEditor = null;
	let value = active.input.value;
	if (active.original === '[[]]' && !parseCodeBlockLinks(value, true).length) {
		value = `[[${value.trim()}]]`;
	}
	active.input.remove();
	active.suggest.close();
	active.item.removeClass('book-view-codeblock-editing');
	if (save && value !== active.original) {
		active.editor.replaceRange(
			value,
			{ line: active.line, ch: active.start },
			{ line: active.line, ch: active.start + active.original.length },
		);
	}
}

/** Open an inline editor for the source line behind `item`: hide the rendered
 *  link, show a note-picker input pre-filled with the raw source line, and
 *  connect Enter (save) / Esc (cancel) / blur (cancel). While the user types,
 *  an `AbstractInputSuggest` popover lists vault notes ranked by the same
 *  fuzzy search as the native `[[` autocomplete; picking one rewrites the
 *  link and closes the editor, so no link has to be typed by hand. */
function openInlineEditor(app: App, item: HTMLElement, editor: Editor, line: number, placeholderStart?: number): void {
	closeInlineEditor(false);
	const text = editor.getLine(line);
	const start = placeholderStart ?? 0;
	const original = placeholderStart === undefined ? text : text.slice(start, start + 4);
	if (placeholderStart !== undefined && original !== '[[]]') return;
	const input = item.createEl('input', {
		cls: 'book-view-codeblock-edit',
		type: 'text',
		value: original,
	});
	input.spellcheck = false;
	item.addClass('book-view-codeblock-editing');
	const suggest = new CodeBlockLinkSuggest(app, input, () => closeInlineEditor(true));
	activeInlineEditor = { item, input, editor, line, start, original, suggest };
	input.addEventListener('click', (evt) => evt.stopPropagation());
	input.addEventListener('keydown', (evt: KeyboardEvent) => {
		if (evt.key === 'Enter') {
			evt.preventDefault();
			evt.stopPropagation();
			// The suggest popover handles Enter itself to pick a suggestion;
			// only commit when no suggestion is shown.
			if (!suggest.isOpen()) closeInlineEditor(true);
		} else if (evt.key === 'Escape') {
			evt.preventDefault();
			evt.stopPropagation();
			if (suggest.isOpen()) {
				suggest.close();
			} else {
				closeInlineEditor(false);
			}
		}
	});
	// Blur fires when the user picks a suggestion from the popover as well as
	// when they click away; defer so the suggest's selectSuggestion (which
	// commits) wins over the cancel-on-blur path.
	input.addEventListener('blur', () => {
		window.setTimeout(() => {
			if (activeInlineEditor?.input === input) closeInlineEditor(false);
		}, 0);
	});
	input.focus({ preventScroll: true });
	if (original === '[[]]') input.setSelectionRange(2, 2);
	else input.select();
}
export function registerBookViewCodeBlock(
	app: App,
	register: (
		language: string,
		handler: (
			source: string,
			el: HTMLElement,
			ctx: MarkdownPostProcessorContext,
		) => void,
	) => void,
	preferredFolder: () => ChapterFolder,
): void {
	let pendingEdit: {
		editor: Editor;
		path: string;
		line: number;
		body: string;
		row: number;
		action: 'highlight' | 'focus' | 'edit';
	} | undefined;
	register('book-view', (source, el, ctx) => {
		const rawLinks = parseCodeBlockLinks(source, true);
		if (rawLinks.length === 0) return;

		const list = el.createDiv({ cls: 'book-view-codeblock-list' });
		const listFile = app.vault.getFileByPath(ctx.sourcePath);
		const locate = () => {
			const editor = findEditorFor(app, list, ctx.sourcePath);
			if (editor) return locateCodeBlock(editor, ctx, el, source);
			return undefined;
		};
		const updateBlock = (block: NonNullable<ReturnType<typeof locate>>, body: string, row: number,
			action: NonNullable<typeof pendingEdit>['action']) => {
			if (body === block.body) return;
			closeInlineEditor(false);
			const update = { editor: block.editor, path: ctx.sourcePath, line: block.line, body, row, action };
			pendingEdit = update;
			block.replaceKeepingScroll(body);
			el.win.setTimeout(() => {
				if (pendingEdit === update) pendingEdit = undefined;
			}, 2000);
		};
		const move = (from: number, to: number, restoreFocus = false) => {
			if (from === to || to < 0 || to >= rawLinks.length) return;
			const block = locate();
			if (!block) {
				new Notice('The chapter list changed. Try moving the link again.');
				return;
			}
			const body = reorderCodeBlockLinks(block.body, from, to);
			updateBlock(block, body, to, restoreFocus ? 'focus' : 'highlight');
		};
		let dragging: number | undefined;
		let dropTarget: HTMLElement | undefined;
		const clearDropTarget = () => {
			dropTarget?.removeClass('book-view-codeblock-drop-before', 'book-view-codeblock-drop-after');
			dropTarget = undefined;
		};

		for (const [index, raw] of rawLinks.entries()) {
			const item = list.createDiv({ cls: 'book-view-codeblock-item' });
			item.dataset.linkOffset = String(raw.offset);
			if (!raw.target) item.dataset.emptyLink = 'true';
			if (listFile && rawLinks.length > 1) {
				const handle = codeBlockButton(item, 'Move link (up or down arrow)', 'grip-vertical', 'book-view-codeblock-grip');
				handle.draggable = true;
				handle.addEventListener('click', (event) => event.stopPropagation());
				handle.addEventListener('keydown', (event) => {
					if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
					event.preventDefault();
					event.stopPropagation();
					move(index, index + (event.key === 'ArrowUp' ? -1 : 1), true);
				});
				handle.addEventListener('dragstart', (event) => {
					if (!locate() || !event.dataTransfer) {
						event.preventDefault();
						return;
					}
					event.stopPropagation();
					dragging = index;
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setData('application/x-book-view-link', String(index));
					const bounds = item.getBoundingClientRect();
					event.dataTransfer.setDragImage(item, event.clientX - bounds.left, event.clientY - bounds.top);
				});
				handle.addEventListener('dragend', () => {
					dragging = undefined;
					clearDropTarget();
				});
			}
			const insertAfter = (event: DragEvent) => {
				const bounds = item.getBoundingClientRect();
				return event.clientY >= bounds.top + bounds.height / 2;
			};
			item.addEventListener('dragover', (event) => {
				if (dragging === undefined) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
				clearDropTarget();
				dropTarget = item;
				item.addClass(insertAfter(event) ? 'book-view-codeblock-drop-after' : 'book-view-codeblock-drop-before');
			});
			item.addEventListener('drop', (event) => {
				if (dragging === undefined) return;
				event.preventDefault();
				event.stopPropagation();
				const slot = index + (insertAfter(event) ? 1 : 0);
				const from = dragging;
				dragging = undefined;
				clearDropTarget();
				move(from, slot > from ? slot - 1 : slot);
			});

			const resolved = raw.target ? app.metadataCache.getFirstLinkpathDest(
				raw.target,
				ctx.sourcePath,
			) : null;

			if (resolved) {
				const link = item.createEl('a', {
					cls: 'internal-link book-view-codeblock-link',
					text: raw.display ?? resolved.basename,
				});
				link.dataset.href = raw.target;
				link.dataset.tooltipPosition = 'top';
			} else {
				item.createSpan({
					cls: raw.target ? 'book-view-codeblock-broken' : 'book-view-codeblock-empty-link',
					text: raw.target ? raw.display ?? raw.target : 'Empty link',
				});
			}
			if (listFile) {
				const add = codeBlockButton(item, 'Add link below', 'plus', 'book-view-codeblock-add');
				add.addEventListener('click', (event) => {
					event.stopPropagation();
					if (!locate()) {
						new Notice('The chapter list changed. Try opening the form again.');
						return;
					}
					closeInlineEditor(false);
					showCreateNotePopover(app, add, listFile, resolved?.extension === 'md' ? resolved : null,
						preferredFolder(), () => !!locate(), (link) => {
							const block = locate();
							if (!block) throw new Error('Chapter list changed');
							block.replace(insertCodeBlockLink(block.body, index, link, block.indent));
						}, () => {
							const block = locate();
							if (!block) {
								new Notice('The chapter list changed. Try opening the form again.');
								return;
							}
							updateBlock(block, insertCodeBlockLink(block.body, index, '[[]]', block.indent), index + 1, 'edit');
						});
				});
			}
		}

		const update = pendingEdit;
		if (update?.path === ctx.sourcePath) {
			el.win.requestAnimationFrame(() => {
				if (pendingEdit !== update) return;
				const block = locate();
				if (block?.editor !== update.editor || block.line !== update.line || block.body !== update.body) return;
				const item = list.children.item(update.row) as HTMLElement | null;
				if (!item) return;
				pendingEdit = undefined;
				if (update.action === 'edit') {
					editCodeBlockRow(app, item, block.editor, block.line, source);
				} else {
					item.addClass('book-view-codeblock-moved');
					if (update.action === 'focus') {
						item.querySelector<HTMLElement>('.book-view-codeblock-grip')?.focus({ preventScroll: true });
					}
				}
			});
		}

		el.addEventListener('click', (evt) =>
			handleCodeBlockClick(app, source, ctx, evt),
		);
	});
}

/**
 * Open the inline editor for the source line behind a clicked rendered row.
 *
 * Only a plain left-click lands (a modifier click or a click in Reading view
 * — where no editor is available — falls through to Obsidian's default
 * behaviour, e.g. opening the internal link).  Relying on `getSectionInfo`,
 * which reports the block's opening-fence line, the row's stored source
 * offset is converted to a line within the fenced content.
 */
function handleCodeBlockClick(
	app: App,
	source: string,
	ctx: MarkdownPostProcessorContext,
	evt: MouseEvent,
): void {
	if (evt.defaultPrevented) return;
	if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;

	const target = evt.target as HTMLElement | null;
	const item = target?.closest?.('.book-view-codeblock-item') as HTMLElement | null;
	if (!item) return;
	const offset = Number(item.dataset.linkOffset);
	if (!Number.isFinite(offset)) return;

	// The whole row is the edit affordance; only intercept where there is an
	// editor to write to (Live Preview). Reading view has none → fall through.
	const editor = findEditorFor(app, item, ctx.sourcePath);
	if (!editor) return;

	evt.preventDefault();
	evt.stopPropagation();

	const info = ctx.getSectionInfo(item);
	if (!info) return;

	editCodeBlockRow(app, item, editor, info.lineStart, source);
}

function editCodeBlockRow(app: App, item: HTMLElement, editor: Editor, fenceLine: number, source: string): void {
	const offset = Number(item.dataset.linkOffset);
	// `source` is the block's inner content (no fences); the line containing
	// the link is `lineStart + 1` (skip the opening fence) plus the 0-based
	// line of the offset within the block content.
	const blockLine = source.slice(0, offset).split('\n').length - 1;
	const line = fenceLine + 1 + blockLine;
	if (line < 0 || line >= editor.lineCount()) return;

	const start = item.dataset.emptyLink ? offset - (source.lastIndexOf('\n', offset - 1) + 1) : undefined;
	openInlineEditor(app, item, editor, line, start);
}

/** The MarkdownView editor owning `item` (its leaf's container contains it),
 *  or null when none (reading view, no editable container). */
function findEditorFor(app: App, item: HTMLElement, sourcePath: string): Editor | null {
	if (!item.closest('.markdown-source-view')) return null;
	const active = app.workspace.activeEditor;
	if (active instanceof MarkdownView && active.file?.path === sourcePath && active.containerEl.contains(item)) {
		return active.editor;
	}
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		if (view.file?.path !== sourcePath || view.getMode() !== 'source') continue;
		if (!view.containerEl.contains(item)) continue;
		if (!view.editor) continue;
		return view.editor;
	}
	return null;
}
