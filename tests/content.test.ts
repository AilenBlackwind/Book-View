import { describe, it, expect } from 'vitest';
import { estimateHeight, guessFirstType, startsWithHeading, stripYamlFrontmatter } from '../src/utils/content';

describe('estimateHeight', () => {
	it('estimates a short text note with the trailing-margin baseline, damped', () => {
		// Raw 16 + 24 = 40; sub-450px estimates are damped by 0.85 → 34,
		// clamped to the 35px floor.
		expect(estimateHeight('hello')).toBe(35);
	});

	it('charges a long wrapped paragraph by rendered line count', () => {
		// Raw 16 + 4×24 = 112, damped ×0.85.
		expect(estimateHeight('x'.repeat(300))).toBeCloseTo((16 + Math.ceil(300 / 85) * 24) * 0.85);
	});

	it('counts every wrapped line of a long callout body', () => {
		const long = `> [!info]\n> ${'y'.repeat(300)}`;
		// Header (title + callout padding) + 4 wrapped body lines, damped.
		expect(estimateHeight(long)).toBeCloseTo((16 + 48 + Math.ceil(300 / 85) * 24) * 0.85);
	});

	it('never under-estimates a wrapped callout line as a single 26px line', () => {
		const wrapped = estimateHeight(`> [!rule]\n> ${'z'.repeat(300)}`);
		expect(wrapped).toBeGreaterThan(16 + 48 + 26);
	});

	it('prices an image inside a callout like a full block, not a text line', () => {
		expect(estimateHeight('> ![[image.png]]')).toBeCloseTo((16 + 300) * 0.85);
	});

	it('handles a nested callout header and body', () => {
		expect(estimateHeight('> > [!note]\n> > inner content')).toBeCloseTo((16 + 48 + 24) * 0.85);
	});

	it('treats a blank quote line as a paragraph gap', () => {
		expect(estimateHeight('> [!tip]\n>\n> text')).toBeCloseTo((16 + 48 + 16 + 24) * 0.85);
	});

	it('estimates a trailing callout above the plain-text estimate for the same content', () => {
		const body = 'word '.repeat(40); // wraps to several rendered lines
		const callout = estimateHeight(`> [!rule]\n> ${body}`);
		const plain = estimateHeight(body);
		expect(callout).toBeGreaterThanOrEqual(plain);
	});

	it('charges a wrapped list item at most two rows', () => {
		// 300 chars would wrap to 4 rows as a paragraph; list items cap at
		// two (EST_LIST_MAX_PX): raw 16 + 52 = 68, damped.
		expect(estimateHeight(`- ${'a'.repeat(300)}`)).toBeCloseTo((16 + 52) * 0.85);
	});

	it('keeps the flat row price for short list items', () => {
		expect(estimateHeight('- item')).toBeCloseTo((16 + 26) * 0.85);
	});

	it('skips phantom trailing-blank margins only for heading-ended notes', () => {
		// Blank lines after the last line render no margin, so they over-inflate
		// a tiny heading-only note (its lazy measurement shrinks it later — the
		// ToC highlight wobble source). A note ending in a heading drops those
		// blanks, matching the heading-only estimate.
		expect(estimateHeight('# Heading\n\n\n')).toBe(estimateHeight('# Heading'));
		// Text- and list-ended notes keep the trailing-blank charge: their body
		// cost is already conservative, and cutting it would under-shoot real
		// notes (e.g. the bullet-heavy Изоляция case).
		expect(estimateHeight('text\n\n\n')).toBeGreaterThan(estimateHeight('text'));
		expect(estimateHeight('- item\n\n\n')).toBeGreaterThan(estimateHeight('- item'));
	});

	it('leaves long estimates uncalibrated', () => {
		// 40 lines × 100 chars → 2 wrapped lines each: raw 16 + 40×48 = 1936.
		// The earlier ×1.1 long-note boost overshot every measured >700px
		// note, so long estimates pass through as-is.
		const text = Array.from({ length: 40 }, () => 'x'.repeat(100)).join('\n');
		expect(estimateHeight(text)).toBeCloseTo(16 + 40 * 48);
	});

	it('leaves mid-size estimates uncalibrated', () => {
		// ~550px raw sits between the short and long thresholds.
		const text = Array.from({ length: 12 }, () => 'x'.repeat(100)).join('\n');
		expect(estimateHeight(text)).toBeCloseTo(16 + 12 * 48);
	});
});

describe('content type guessing ignores YAML frontmatter', () => {
	it('guessFirstType skips frontmatter and reports the following heading', () => {
		const note = '---\nchapters:\n  - a\n---\n## Заголовок';
		expect(guessFirstType(note)).toBe('h2');
	});

	it('guessFirstType skips frontmatter and reports following text', () => {
		const note = '---\nkey: value\n---\nОбычный текст';
		expect(guessFirstType(note)).toBe('text');
	});

	it('guessFirstType still detects a plain heading without frontmatter', () => {
		expect(guessFirstType('## Заголовок')).toBe('h2');
	});

	it('startsWithHeading skips frontmatter to find a heading', () => {
		const note = '---\ntags: [x]\n---\n# Заголовок';
		expect(startsWithHeading(note)).toBe(true);
	});

	it('startsWithHeading is false when frontmatter is followed by text', () => {
		const note = '---\ntags: [x]\n---\nОбычный текст';
		expect(startsWithHeading(note)).toBe(false);
	});

	it('does not mistake non-frontmatter leading `---` for a fence', () => {
		expect(guessFirstType('---\nне frontmatter')).toBe('text');
	});
});

describe('stripYamlFrontmatter', () => {
	it('removes a leading YAML frontmatter block', () => {
		const note = '---\ntags: [x]\n---\n## Заголовок\n\nтекст';
		expect(stripYamlFrontmatter(note)).toBe('## Заголовок\n\nтекст');
	});

	it('handles frontmatter closed with `...`', () => {
		expect(stripYamlFrontmatter('---\nkey: v\n...\n# H')).toBe('# H');
	});

	it('returns the text unchanged when there is no frontmatter', () => {
		expect(stripYamlFrontmatter('## Заголовок\n\nтекст')).toBe('## Заголовок\n\nтекст');
	});

	it('returns the text unchanged for an unterminated leading fence', () => {
		expect(stripYamlFrontmatter('---\nне закрытый')).toBe('---\nне закрытый');
	});
});
