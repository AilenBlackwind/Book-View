import { describe, it, expect } from 'vitest';
import { estimateHeight } from '../src/utils/content';

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
