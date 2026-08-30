import { App, Component, MarkdownRenderer } from 'obsidian';

export interface ThemeSpacings {
	h1TopGap: number;
	h2TopGap: number;
	headerToHeaderGap: number;
	textGap: number;
}

export const DEFAULT_THEME_SPACINGS: ThemeSpacings = {
	h1TopGap: 52,
	h2TopGap: 34,
	headerToHeaderGap: 0,
	textGap: 16,
};

/** Measures the theme's vertical rhythm (gaps around headings and paragraphs)
 *  by rendering a probe snippet off-screen. Falls back to defaults when the
 *  probe fails. */
const PROBE_STYLE =
	'position: absolute !important; visibility: hidden !important; pointer-events: none !important; left: -9999px !important; top: -9999px !important; width: 800px !important;';

const headingOf = (el: Element): string | null => {
	if (/^H[1-6]$/i.test(el.tagName)) return el.tagName.toLowerCase();
	const inner = el.querySelector('h1, h2, h3, h4, h5, h6');
	if (inner) return inner.tagName.toLowerCase();
	for (let i = 1; i <= 6; i++) if (el.classList.contains(`el-h${i}`)) return `h${i}`;
	return null;
};

const isParagraph = (el: Element): boolean =>
	el.tagName === 'P' || el.querySelector('p') != null || el.classList.contains('el-p');

/** Vertical gap between the bottoms/tops of two adjacent blocks. */
const gapBetween = (prev: Element, next: Element): number =>
	Math.round(next.getBoundingClientRect().top - prev.getBoundingClientRect().bottom);

/** Measures the theme's vertical rhythm (gaps around headings and paragraphs)
 *  by rendering probe snippets off-screen against consecutive parent blocks.
 *  Falls back to defaults when a probe fails. */
export async function measureThemeSpacings(app: App): Promise<ThemeSpacings> {
	const probe = document.body.createDiv({
		cls: 'book-view-probe markdown-rendered',
		attr: { style: PROBE_STYLE },
	});

	const spacings: ThemeSpacings = { ...DEFAULT_THEME_SPACINGS };

	try {
		// Rendering into a bare off-screen div (outside a note) yields plain
		// <P>/<H1>/<H2> block elements with no .el-* wrapper, so each metric is
		// measured from the gap between two adjacent blocks of the right types.
		const renderBlocks = async (markdown: string): Promise<Element[]> => {
			probe.empty();
			const component = new Component();
			try {
				await MarkdownRenderer.render(app, markdown, probe, '', component);
			} finally {
				component.unload();
			}
			return Array.from(probe.children).filter((el) => {
				if (el.tagName === 'PRE' && el.classList.contains('frontmatter')) return false;
				if (el.classList.contains('frontmatter-container')) return false;
				if (el.classList.contains('metadata-container')) return false;
				return true;
			});
		};

		// Probe 1: paragraph -> h1 and h1 -> h2.
		const probe1 = await renderBlocks('Текст-1\n\n# Заголовок H1\n\n## Заголовок H2');
		const p1 = probe1.find(isParagraph);
		const h1 = probe1.find((el) => headingOf(el) === 'h1');
		const h2 = probe1.find((el) => headingOf(el) === 'h2');

		if (p1 && h1) spacings.h1TopGap = gapBetween(p1, h1);
		if (h1 && h2) spacings.headerToHeaderGap = gapBetween(h1, h2);

		// Probe 2: paragraph -> h2.
		const probe2 = await renderBlocks('Текст-1\n\n## Заголовок H2');
		const p2a = probe2.find(isParagraph);
		const h2b = probe2.find((el) => headingOf(el) === 'h2');
		if (p2a && h2b) spacings.h2TopGap = gapBetween(p2a, h2b);

		// Probe 3: two adjacent paragraphs -> textGap.
		const probe3 = await renderBlocks('Текст-1\n\nТекст-2');
		const paragraphs = probe3.filter(isParagraph);
		if (paragraphs.length >= 2) {
			const textGap = gapBetween(paragraphs[0]!, paragraphs[1]!);
			if (textGap >= 0) spacings.textGap = textGap;
		}
	} catch (e) {
		console.warn('BookView: theme probe failed, using defaults', e);
	} finally {
		probe.remove();
	}

	return spacings;
}
