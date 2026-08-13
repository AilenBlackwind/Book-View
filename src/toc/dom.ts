import { renderInlineMarkdown, stripMarkdown } from '../utils/renderInlineMarkdown';

/** Render a heading's label into `parent`. With the render-markdown setting
 *  on, the inline markdown is parsed through a DOMParser so tags/bold/italic/
 *  code become real DOM nodes; otherwise a plain stripped-text span. Returns
 *  the created span so callers can cache it and clone on later row rebuilds. */
export function renderHeadingLabel(parent: HTMLElement, text: string, renderMarkdown: boolean): HTMLElement {
	if (renderMarkdown) {
		const span = parent.createSpan();
		const html = renderInlineMarkdown(text);
		const doc = new DOMParser().parseFromString(html, 'text/html');
		while (doc.body.firstChild) {
			span.appendChild(doc.body.firstChild);
		}
		return span;
	}
	return parent.createSpan({ text: stripMarkdown(text) });
}
