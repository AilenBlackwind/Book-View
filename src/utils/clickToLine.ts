/**
 * Pure geometry-free helpers for mapping a click on a rendered section block
 * to a source line. No DOM, no Obsidian imports — safe to unit-test alone.
 *
 * The rendered note (Obsidian `MarkdownRenderer` output) is a vertical stack
 * of block elements in source order, while `metadataCache.sections` lists the
 * same blocks with exact source line ranges. The two orders can drift apart
 * (frontmatter is stripped before render, lists/embeds/callouts wrap blocks),
 * so domToSectionOffset anchors the mapping on headings — rendered headings
 * carry a data-fold-id whose `L{i}` value is the exact raw source line, and
 * heading-type sections expose the same lines in the same order.
 */

/** A single metadataCache section, reduced to what line math needs. */
export interface LineSection {
	startLine: number;
	endLine: number;
	type: string;
}

/** Line `i` from the rendered data-fold-id `…path#L{i}`. */
export function foldIdLine(foldId: string): number | null {
	const match = /#L(\d+)$/.exec(foldId.trim());
	if (!match) return null;
	return Number(match[1]);
}

/** A rendered heading block: its exact source line and its 0-based index
 *  among the rendered top-level blocks (used to compute the DOM→section
 *  index offset). */
export interface DomHeading {
	blockIndex: number;
	line: number;
}

/**
 * Constant index offset to apply to a rendered block index when the two
 * lists are lockstep, else null when the anchors disagree (wrapper blocks
 * shift the DOM order against the section order, or the content is stale).
 *
 * Each rendered heading must match a `heading`-type section at the same
 * source line; the offset `sectionIndex - blockIndex` must be the same for
 * every heading. With no headings it assumes a 1:1 DOM↔section order, which
 * holds once yaml sections are filtered out — the caller must exclude those
 * before calling.
 */
export function domToSectionOffset(
	domHeadings: DomHeading[],
	sections: LineSection[],
): number | null {
	if (domHeadings.length === 0) return 0;
	let offset: number | null = null;
	let hi = 0;
	for (let si = 0; si < sections.length && hi < domHeadings.length; si++) {
		const s = sections[si];
		if (!s || s.type !== 'heading' || s.startLine !== domHeadings[hi]?.line) continue;
		const candidate = si - (domHeadings[hi]?.blockIndex ?? 0);
		if (offset === null) offset = candidate;
		else if (offset !== candidate) return null;
		hi++;
	}
	if (hi < domHeadings.length) return null; // a rendered heading never matched a section
	return offset ?? 0;
}

/** Map a rendered-height fraction of a block onto its source lines. */
export function lineAtFraction(sec: LineSection, fraction: number): number {
	const span = Math.max(0, sec.endLine - sec.startLine);
	const clamped = Math.max(0, Math.min(1, fraction));
	return sec.startLine + Math.min(span, Math.round(clamped * span));
}