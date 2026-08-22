/**
 * Pure text-level content analysis: height estimation and heading detection.
 * No DOM, no Obsidian imports — safe to unit-test in isolation.
 */

/** Calibration constants fitted against measured heights (DBG height-change
 *  pairs over a stress book): sub-~450px stub notes render ~15% shorter than
 *  the raw line-sum (fixed margins dominate there); mid-size and long notes
 *  match once list items are priced correctly — an earlier long-note boost
 *  (×1.1) consistently overshot every measured >700px note and was removed.
 *  Re-fit against fresh pairs rather than touching the per-line prices. */
const EST_SHORT_PX = 450;
const EST_SHORT_FACTOR = 0.85;
/** A wrapped list item costs at most two rows: beyond that the wrap estimate
 *  outruns reality (nested markers, tight line-height in lists). */
const EST_LIST_MAX_PX = 52;

/** Rough rendered-height estimate (px) for a markdown source string, used as
 *  the pre-render spacer height before the real height is measured. */
export function estimateHeight(text: string): number {
	let estimated = 16; // trailing paragraph margin
	const lines = text.split('\n');
	let inCode = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^```/.test(trimmed)) {
			inCode = !inCode;
			estimated += 22;
			continue;
		}
		if (trimmed.length === 0) {
			estimated += 16; // rendered paragraph margin
			continue;
		}
		if (inCode) {
			estimated += 22;
			continue;
		}
		const heading = /^(#{1,6})\s/.exec(trimmed);
		if (heading) {
			estimated += 48 - (heading[1]?.length ?? 1) * 2;
			continue;
		}
		if (trimmed.startsWith('>')) {
			// Blockquote / callout: strip the quote prefixes and charge the
			// content like the same markdown rendered outside the quote. The
			// old flat 26px per `>` line treated a wrapped callout paragraph
			// as one rendered line, so callouts with long lines, images, or
			// tables were under-estimated by hundreds of px — the note box
			// ended above a trailing callout's text and clipped it. Wrapped
			// lines (chars / 85) and the callout's own padding make the
			// estimate land at or above the real height until the resize
			// observer corrects it.
			const content = trimmed.replace(/^(>\s*)+/, '');
			if (content.length === 0) {
				estimated += 16; // blank quote line
				continue;
			}
			if (/^\[!/.test(content)) {
				// Callout header: title row + the callout's top/bottom padding.
				// A long title wraps like any other text.
				const titleLines = Math.max(1, Math.ceil(content.length / 85));
				estimated += 48 + (titleLines - 1) * 24;
				continue;
			}
			if (/!\[.*?\]\(.*?\)|!\[\[.*?\]\]/.test(content)) {
				estimated += 300;
				continue;
			}
			if (/^#{1,6}\s/.test(content)) {
				const lvl = content.indexOf('#');
				estimated += 48 - (lvl + 1) * 2;
				continue;
			}
			estimated += Math.ceil(content.length / 85) * 24;
			continue;
		}
		if (/^(-|\*|\+|\d+\.)\s/.test(trimmed)) {
			// A list item costs at least one row; a long item wraps, but no
			// more than two rows (see EST_LIST_MAX_PX). The flat 26px
			// under-charged list-heavy container notes by hundreds of px.
			estimated += Math.max(26, Math.min(Math.ceil(trimmed.length / 85) * 24, EST_LIST_MAX_PX));
			continue;
		}
		if (/!\[.*?\]\(.*?\)|!\[\[.*?\]\]/.test(trimmed)) {
			estimated += 300;
			continue;
		}
		estimated += Math.ceil(trimmed.length / 85) * 24;
	}

	// Short-note damping (see the constants above); mid-size and long notes
	// pass through uncalibrated.
	if (estimated < EST_SHORT_PX) estimated *= EST_SHORT_FACTOR;
	return Math.max(35, estimated);
}

/** True when the first non-empty line of the text is a markdown heading. */
export function startsWithHeading(text: string): boolean {
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		return /^#{1,6}\s/.test(trimmed);
	}
	return false;
}

/** True when the last non-empty line of the text is a markdown heading. */
export function endsWithHeading(text: string): boolean {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i]?.trim() ?? '';
		if (trimmed.length === 0) continue;
		return /^#{1,6}\s/.test(trimmed);
	}
	return false;
}

/** First non-empty line's type: 'h1'..'h6' or 'text'. */
export function guessFirstType(text: string): string {
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const match = /^(#{1,6})\s/.exec(trimmed);
		if (match) return `h${(match[1] as string).length}`;
		return 'text';
	}
	return 'text';
}

/** Last non-empty line's type: 'h1'..'h6' or 'text'. */
export function guessLastType(text: string): string {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i]?.trim() ?? '';
		if (trimmed.length === 0) continue;
		const match = /^(#{1,6})\s/.exec(trimmed);
		if (match) return `h${(match[1] as string).length}`;
		return 'text';
	}
	return 'text';
}
