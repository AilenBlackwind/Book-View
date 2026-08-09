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
export async function measureThemeSpacings(app: App): Promise<ThemeSpacings> {
	const probe = document.body.createDiv({
		cls: 'book-view-probe markdown-rendered',
		attr: {
			style: 'position: absolute !important; visibility: hidden !important; pointer-events: none !important; left: -9999px !important; top: -9999px !important; width: 800px !important;',
		},
	});

	const testMarkdown = 'Тест 1\n\n# Заголовок 1\n\n## Заголовок 2\n\nТест 2';
	const spacings: ThemeSpacings = { ...DEFAULT_THEME_SPACINGS };

	try {
		const component = new Component();
		await MarkdownRenderer.render(app, testMarkdown, probe, '', component);

		const blocks = Array.from(probe.children).filter((el) => {
			if (el.tagName === 'PRE' && el.classList.contains('frontmatter')) return false;
			if (el.classList.contains('frontmatter-container')) return false;
			if (el.classList.contains('metadata-container')) return false;
			return true;
		});

		const p1Block = blocks.find(
			(el) => el.querySelector('p, .el-p') || el.classList.contains('el-p'),
		);
		const h1Block = blocks.find(
			(el) => el.querySelector('h1') || el.classList.contains('el-h1'),
		);
		const h2Block = blocks.find(
			(el) => el.querySelector('h2') || el.classList.contains('el-h2'),
		);
		const p2Block = [...blocks].reverse().find(
			(el) => el.querySelector('p, .el-p') || el.classList.contains('el-p'),
		);

		if (p1Block && h1Block) {
			spacings.h1TopGap = Math.round(
				h1Block.getBoundingClientRect().top - p1Block.getBoundingClientRect().bottom,
			);
		}
		if (h1Block && h2Block) {
			spacings.headerToHeaderGap = Math.round(
				h2Block.getBoundingClientRect().top - h1Block.getBoundingClientRect().bottom,
			);
		}
		if (p1Block && h2Block) {
			spacings.h2TopGap = Math.round(
				h2Block.getBoundingClientRect().top - p1Block.getBoundingClientRect().bottom,
			);
		}
		if (p1Block && p2Block) {
			const textGap = Math.round(
				p2Block.getBoundingClientRect().top - p1Block.getBoundingClientRect().bottom,
			);
			if (textGap >= 0) spacings.textGap = textGap;
		}

		component.unload();
	} catch (e) {
		console.warn('BookView: theme probe failed, using defaults', e);
	} finally {
		probe.remove();
	}

	return spacings;
}
