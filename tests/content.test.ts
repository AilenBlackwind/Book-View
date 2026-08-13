import { describe, it, expect } from 'vitest';
import { estimateHeight } from '../src/utils/content';

describe('estimateHeight', () => {
	it('estimates a short text note with the trailing-margin baseline', () => {
		expect(estimateHeight('hello')).toBe(16 + 24);
	});

	it('charges a long wrapped paragraph by rendered line count', () => {
		expect(estimateHeight('x'.repeat(300))).toBe(16 + Math.ceil(300 / 85) * 24);
	});

	it('counts every wrapped line of a long callout body', () => {
		const long = `> [!info]\n> ${'y'.repeat(300)}`;
		// Header (title + callout padding) + 4 wrapped body lines.
		expect(estimateHeight(long)).toBe(16 + 48 + Math.ceil(300 / 85) * 24);
	});

	it('never under-estimates a wrapped callout line as a single 26px line', () => {
		const wrapped = estimateHeight(`> [!rule]\n> ${'z'.repeat(300)}`);
		expect(wrapped).toBeGreaterThan(16 + 48 + 26);
	});

	it('prices an image inside a callout like a full block, not a text line', () => {
		expect(estimateHeight('> ![[image.png]]')).toBe(16 + 300);
	});

	it('handles a nested callout header and body', () => {
		expect(estimateHeight('> > [!note]\n> > inner content')).toBe(16 + 48 + 24);
	});

	it('treats a blank quote line as a paragraph gap', () => {
		expect(estimateHeight('> [!tip]\n>\n> text')).toBe(16 + 48 + 16 + 24);
	});

	it('estimates a trailing callout above the plain-text estimate for the same content', () => {
		const body = 'word '.repeat(40); // wraps to several rendered lines
		const callout = estimateHeight(`> [!rule]\n> ${body}`);
		const plain = estimateHeight(body);
		expect(callout).toBeGreaterThanOrEqual(plain);
	});
});
