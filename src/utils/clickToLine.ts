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

/* ---------------------------------------------------------------- *
 *  Content-derived line model.                                      *
 *  The book renders a section from its own `rawContent` copy, while *
 *  `metadataCache` (sections/listItems/headings) refreshes async    *
 *  after an edit and the plugin's data-fold-ids are re-tagged from  *
 *  a heading index built once per book load. Both can lag the DOM.  *
 *  These helpers parse `rawContent` — the exact text the DOM was    *
 *  rendered from — so the line model always agrees with what the    *
 *  user sees, and the cache path keeps working as a fallback.       *
 *  Line numbers are 0-based, matching fold-id `#L{i}` and the       *
 *  cache's `position.start.line`.                                   *
 * ---------------------------------------------------------------- */

const ATX_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
const BULLET_RE = /^\s{0,3}([-+*])\s+/;
const ORDERED_RE = /^\s{0,3}(?:\d{1,9})[.)]\s+/;
const QUOTE_RE = /^\s{0,3}>/;
const THEMATIC_BREAK_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEPARATOR_RE = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** True when `line` opens a CommonMark top-level block (not a lazy
 *  paragraph continuation). Used by the paragraph/blockquote consumers
 *  to decide where a block ends. */
function isBlockStart(line: string): boolean {
	const t = line.trim();
	if (!t) return false;
	if (ATX_HEADING_RE.test(line)) return true;
	if (FENCE_OPEN_RE.test(line)) return true;
	if (QUOTE_RE.test(line)) return true;
	if (BULLET_RE.test(line) || ORDERED_RE.test(line)) return true;
	if (THEMATIC_BREAK_RE.test(line)) return true;
	return false;
}

/** A CommonMark regex match repeated against the given string (single-use
 *  pattern helper — anchoring `g` flags across calls is avoided on purpose). */
function lineStartsWithFence(line: string): string | null {
	const m = FENCE_OPEN_RE.exec(line);
	return m ? (m[1] as string)[0] ?? '' : null;
}

/**
 * Split markdown into the top-level blocks Obsidian renders, in source
 * order, excluding the leading YAML block. Each entry carries the file line
 * range (0-based). Only `startLine`, `endLine` and `type==='heading'` matter
 * for click mapping; other types are opaque.
 *
 * Best-effort CommonMark-ish: ATX and setext headings, paragraphs, fenced and
 * indented code, blockquotes (Obsidian callouts), bullet/ordered/task lists
 * (nested + continuation), pipe tables and thematic breaks. Where the scan
 * diverges from Obsidian's segmentation the caller falls back to the cached
 * model, so this only ever narrows the mapping — never widens it.
 */
export function scanContentBlocks(content: string): LineSection[] {
	const lines = content.split('\n');
	const n = lines.length;
	const blocks: LineSection[] = [];

	// Leading YAML frontmatter is rendered away, so it is skipped here too.
	let i = 0;
	if ((lines[0]?.trim() ?? '') === '---') {
		let end = -1;
		for (let j = 1; j < n; j++) {
			if ((lines[j]?.trim() ?? '') === '---') {
				end = j;
				break;
			}
		}
		if (end >= 0) i = end + 1;
	}

	const nextIsSetext = (line: string, next: string): boolean => {
		const t = next.trim();
		if (/^=+$/.test(t)) return true;
		if (!/^-{2,}$/.test(t)) return false;
		// `---` after a line is a setext underline; a bare `- - -` or a list
		// marker line is not.
		if (BULLET_RE.test(line) || ORDERED_RE.test(line)) return false;
		return !isBlockStart(line) && !THEMATIC_BREAK_RE.test(line);
	};

	while (i < n) {
		const line = lines[i] ?? '';
		const trimmed = line.trim();
		if (!trimmed) {
			i++;
			continue;
		}

		// Fenced code.
		const fenceChar = lineStartsWithFence(line);
		if (fenceChar !== null) {
			const re = fenceChar === '`' ? /^`{3,}/ : /^~{3,}/;
			let j = i + 1;
			let close = -1;
			for (; j < n; j++) {
				if (re.test((lines[j] ?? '').trim())) {
					close = j;
					break;
				}
			}
			blocks.push({ type: 'code', startLine: i, endLine: close >= 0 ? close : n - 1 });
			i = (close >= 0 ? close : n - 1) + 1;
			continue;
		}

		// ATX heading (column 0–3).
		if (ATX_HEADING_RE.test(line)) {
			blocks.push({ type: 'heading', startLine: i, endLine: i });
			i++;
			continue;
		}

		// Setext heading: paragraph line followed by `===` / `---`.
		if (i + 1 < n && nextIsSetext(line, lines[i + 1] ?? '')) {
			blocks.push({ type: 'heading', startLine: i, endLine: i + 1 });
			i += 2;
			continue;
		}

		// Pipe table: header row + separator row, then consecutive rows.
		if (trimmed.includes('|') && i + 1 < n && TABLE_SEPARATOR_RE.test(lines[i + 1]?.trim() ?? '')) {
			let j = i;
			let last = i;
			for (; j < n; j++) {
				const t = (lines[j] ?? '').trim();
				if (!t) break;
				if (t.includes('|') || TABLE_SEPARATOR_RE.test(t)) {
					last = j;
					continue;
				}
				break;
			}
			blocks.push({ type: 'table', startLine: i, endLine: last });
			i = last + 1;
			continue;
		}

		// Thematic break.
		if (THEMATIC_BREAK_RE.test(line)) {
			blocks.push({ type: 'hr', startLine: i, endLine: i });
			i++;
			continue;
		}

		// Blockquote / callout, with lazy paragraph continuation.
		if (QUOTE_RE.test(line)) {
			let j = i;
			let last = i;
			for (; j < n; j++) {
				const t = lines[j] ?? '';
				const tt = t.trim();
				if (!tt) {
					let k = j;
					while (k < n && !(lines[k] ?? '').trim()) k++;
					const nxt = lines[k] ?? '';
					if (nxt && QUOTE_RE.test(nxt)) {
						last = k;
						j = k;
						continue;
					}
					break;
				}
				if (QUOTE_RE.test(t)) {
					last = j;
					continue;
				}
				// Lazy continuation: an unquoted line that does not start a
				// new block still belongs to the quote's paragraph.
				if (!isBlockStart(t)) {
					last = j;
					continue;
				}
				break;
			}
			blocks.push({ type: 'blockquote', startLine: i, endLine: last });
			i = last + 1;
			continue;
		}

		// List: one block spanning markers, nested items and continuations.
		if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
			let j = i;
			let last = i;
			for (; j < n; j++) {
				const t = lines[j] ?? '';
				if (!t.trim()) {
					let k = j;
					while (k < n && !(lines[k] ?? '').trim()) k++;
					const nxt = lines[k] ?? '';
					if (nxt && (BULLET_RE.test(nxt) || ORDERED_RE.test(nxt) || /^[ \t]/.test(nxt))) {
						last = k;
						j = k;
						continue;
					}
					break;
				}
				if (BULLET_RE.test(t) || ORDERED_RE.test(t)) {
					last = j;
					continue;
				}
				// Indented content continues the previous item; everything
				// else (headings, quotes, fences, unindented text) ends it.
				if (/^[ \t]/.test(t) && !isBlockStart(t)) {
					last = j;
					continue;
				}
				break;
			}
			blocks.push({ type: 'list', startLine: i, endLine: last });
			i = last + 1;
			continue;
		}

		// Paragraph: consume until the next block starts.
		let j = i;
		let last = i;
		for (; j < n; j++) {
			const t = lines[j] ?? '';
			if (!t.trim() && j !== i) break;
			if (t.trim() && (ATX_HEADING_RE.test(t) || isBlockStart(t))) break;
			// A following `---`/`===` underlines make this a setext heading —
			// stop so the underline line starts its own block.
			if (j + 1 < n && nextIsSetext(t, lines[j + 1] ?? '')) break;
			last = j;
		}
		blocks.push({ type: 'paragraph', startLine: i, endLine: last });
		i = last + 1;
	}

	return blocks;
}

/** Source line of each rendered list item, in document (= DOM `<li>`)
 *  order. Skips YAML frontmatter and fenced code, and normalises blockquote
 *  (`>`) prefixes so items inside callouts/blockquotes are counted too. */
export function listItemStartLines(content: string): number[] {
	const lines = content.split('\n');
	const result: number[] = [];

	let inYaml = (lines[0]?.trim() ?? '') === '---';
	let fenceChar: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? '';
		const trimmed = raw.trim();

		if (inYaml) {
			if (trimmed === '---') inYaml = false;
			continue;
		}

		if (fenceChar === null) {
			const open = FENCE_OPEN_RE.exec(raw);
			if (open) {
				fenceChar = (open[1] as string)[0] ?? '';
				continue;
			}
		} else {
			if (trimmed.startsWith(fenceChar) && /^[`~]{3,}/.test(trimmed)) fenceChar = null;
			continue;
		}

		// Strip one or more `>` prefixes (callout/blockquote items) before
		// testing for a list marker, so `> - item` and `>> - item` count.
		let core = raw;
		while (/^\s*>/.test(core)) core = core.replace(/^\s*>/, '');

		const bullet = /^\s{0,3}[-+*]\s+/.exec(core);
		const ordered = /^\s{0,3}(?:\d{1,9})[.)]\s+/.exec(core);
		if (bullet || ordered) result.push(i);
	}

	return result;
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
 *
 * Callers must pass only REAL headings (h1–h6): collapsible list items also
 * carry data-fold-id and would otherwise be treated as anchors, fail to
 * match any heading section, and flatten the whole estimate to null.
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

/**
 * Source line of the `domIndex`-th rendered list item of a list block. A list
 * renders as one `<ul>`/`<ol>` block (one `list` section), inside which each
 * item is an `<li>` — but the items can wrap, nest, or hold callouts, so
 * interpolating the click fraction across the section span misplaces the
 * cursor onto a neighbouring item. Obsidian's `cache.listItems` records each
 * item's exact start line, so when the rendered `<li>` count matches the
 * section-span item count, return the precise line of the clicked item.
 *
 * Returns null (caller falls back to `lineAtFraction`) when the counts
 * disagree.
 */
export function lineForListItem(
	sec: LineSection,
	domCount: number,
	listItemStartLines: number[],
	domIndex: number,
): number | null {
	if (domIndex < 0 || domIndex >= domCount) return null;
	const inSpan = listItemStartLines.filter((l) => l >= sec.startLine && l <= sec.endLine);
	if (inSpan.length !== domCount) return null;
	return inSpan[domIndex] ?? null;
}