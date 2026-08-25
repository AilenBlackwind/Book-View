import { App, MarkdownPostProcessorContext } from 'obsidian';
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
	register('book-view', (source, el) => {
		const rawLinks = parseCodeBlockLinks(source);
		if (rawLinks.length === 0) return;

		const list = el.createDiv({ cls: 'book-view-codeblock-list' });

		for (const raw of rawLinks) {
			const item = list.createDiv({ cls: 'book-view-codeblock-item' });

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
	});
}
