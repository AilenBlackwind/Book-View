import { App, Editor, MarkdownPostProcessorContext, MarkdownView } from 'obsidian';
import { parseCodeBlockLinks } from './CodeBlockParser';
import { CodeBlockLinkSuggest } from './CodeBlockLinkSuggest';

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
	const value = active.input.value;
	active.input.remove();
	active.suggest.close();
	active.item.removeClass('book-view-codeblock-editing');
	if (save && value !== active.original) {
		active.editor.replaceRange(
			value,
			{ line: active.line, ch: 0 },
			{ line: active.line, ch: active.original.length },
		);
	}
}

/** Open an inline editor for the source line behind `item`: hide the rendered
 *  link, show a note-picker input pre-filled with the raw source line, and
 *  connect Enter (save) / Esc (cancel) / blur (cancel). While the user types,
 *  an `AbstractInputSuggest` popover lists vault notes ranked by the same
 *  fuzzy search as the native `[[` autocomplete; picking one rewrites the
 *  link and closes the editor, so no link has to be typed by hand. */
function openInlineEditor(app: App, item: HTMLElement, editor: Editor, line: number): void {
	closeInlineEditor(false);
	const original = editor.getLine(line);
	const input = item.createEl('input', {
		cls: 'book-view-codeblock-edit',
		type: 'text',
		value: original,
	});
	input.spellcheck = false;
	item.addClass('book-view-codeblock-editing');
	const suggest = new CodeBlockLinkSuggest(app, input, () => closeInlineEditor(true));
	activeInlineEditor = { item, input, editor, line, original, suggest };
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
	input.focus();
	input.select();
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
): void {
	register('book-view', (source, el, ctx) => {
		const rawLinks = parseCodeBlockLinks(source);
		if (rawLinks.length === 0) return;

		const list = el.createDiv({ cls: 'book-view-codeblock-list' });

		for (const raw of rawLinks) {
			const item = list.createDiv({ cls: 'book-view-codeblock-item' });
			item.dataset.linkOffset = String(raw.offset ?? 0);

			const resolved = app.metadataCache.getFirstLinkpathDest(
				raw.target,
				'',
			);

			if (resolved) {
				const link = item.createEl('a', {
					cls: 'internal-link book-view-codeblock-link',
					text: raw.display ?? resolved.basename,
				});
				link.dataset.href = raw.target;
				link.dataset.tooltipPosition = 'top';
			} else {
				item.createSpan({
					cls: 'book-view-codeblock-broken',
					text: raw.display ?? raw.target,
				});
			}
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
	const editor = findEditorFor(app, item);
	if (!editor) return;

	evt.preventDefault();
	evt.stopPropagation();

	const info = ctx.getSectionInfo(item);
	if (!info?.lineStart) return;

	// `source` is the block's inner content (no fences); the line containing
	// the link is `lineStart + 1` (skip the opening fence) plus the 0-based
	// line of the offset within the block content.
	const blockLine = source.slice(0, offset).split('\n').length - 1;
	const line = info.lineStart + 1 + blockLine;
	if (line < 0 || line >= editor.lineCount()) return;

	openInlineEditor(app, item, editor, line);
}

/** The MarkdownView editor owning `item` (its leaf's container contains it),
 *  or null when none (reading view, no editable container). */
function findEditorFor(app: App, item: HTMLElement): Editor | null {
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		if (!view.containerEl.contains(item)) continue;
		if (!view.editor) continue;
		return view.editor;
	}
	return null;
}
