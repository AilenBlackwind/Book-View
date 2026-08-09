/**
 * Pure DOM helpers for walking the rendered note content. No Obsidian imports.
 */

/** True when a rendered child must be skipped when scanning for the first/last
 *  content element (frontmatter, metadata, headers, hidden blocks). */
export function isIgnoredElement(el: Element): boolean {
	if (el.tagName === 'PRE' && el.classList.contains('frontmatter')) return true;
	if (el.classList.contains('frontmatter-container')) return true;
	if (el.classList.contains('metadata-container')) return true;
	if (el.classList.contains('mod-header')) return true;
	if ((el as HTMLElement).style.display === 'none') return true;
	return false;
}

/** First non-ignored child of the note's .markdown-rendered container. */
export function getFirstContentElement(noteEl: HTMLElement): Element | null {
	const rendered = noteEl.classList.contains('markdown-rendered')
		? noteEl
		: (noteEl.querySelector('.markdown-rendered') || noteEl);
	for (const child of Array.from(rendered.children)) {
		if (isIgnoredElement(child)) continue;
		return child;
	}
	return null;
}

/** Last non-ignored child of the note's .markdown-rendered container. */
export function getLastContentElement(noteEl: HTMLElement): Element | null {
	const rendered = noteEl.classList.contains('markdown-rendered')
		? noteEl
		: (noteEl.querySelector('.markdown-rendered') || noteEl);
	const children = Array.from(rendered.children);
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i];
		if (!child) continue;
		if (isIgnoredElement(child)) continue;
		return child;
	}
	return null;
}

/** Heading level ('h1'..'h6') of an element, or null when it is not a heading.
 *  Handles bare h* tags, Obsidian's .el-h* wrappers, and nested headings. */
export function getHeaderLevel(el: Element): string | null {
	if (/^H[1-6]$/i.test(el.tagName)) return el.tagName.toLowerCase();

	for (let i = 1; i <= 6; i++) {
		if (el.classList.contains(`el-h${i}`)) return `h${i}`;
	}

	const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
	if (heading) return heading.tagName.toLowerCase();

	return null;
}
