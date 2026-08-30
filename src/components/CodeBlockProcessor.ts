import { App, MarkdownPostProcessorContext, MarkdownView } from 'obsidian';
import { parseCodeBlockLinks } from './CodeBlockParser';

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
 * place the editor cursor on the matching source line.
 */
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
 * Place the editor cursor on the source line behind a clicked rendered row.
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
	// editor to move (Live Preview). Reading view has none → fall through.
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
	// Place the cursor at the end of the source line (natural spot for
	// editing the entry). Note: landing the cursor inside a fenced block makes
	// Obsidian swap the rendered list back to the editable text block; the
	// scroller may park at the block's bottom, in which case a manual arrow
	// key pulls the view back — Obsidian's own scroll-to-cursor then applies.
	const endPos = editor.offsetToPos(
		editor.posToOffset({ line, ch: 0 }) + editor.getLine(line).length,
	);
	editor.setCursor(endPos);
	editor.focus();
}

/** The MarkdownView editor owning `item` (its leaf's container contains it),
 *  or null when none (reading view, no editable container). */
function findEditorFor(app: App, item: HTMLElement): (typeof MarkdownView.prototype.editor) | null {
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		if (!view.containerEl.contains(item)) continue;
		if (!view.editor) continue;
		return view.editor;
	}
	return null;
}
