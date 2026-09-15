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

	// A box's bottom edge sits at its last line — blank lines after the last
	// non-empty line render no margin (block bottom margins collapse past the
	// final line box). When the note ends in a heading those trailing blanks
	// are pure phantom height, over-inflating tiny sections so a lazy-loaded
	// measurement shrinks them back later (seen as ToC highlight wobble).
	// Skip charging them only for heading-ended notes; text/list-ended notes
	// keep the charge so their (already conservative) body cost isn't cut.
	let lastNonEmpty = -1;
	let lastIsHeading = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] && lines[i]!.trim().length > 0) {
			lastNonEmpty = i;
			lastIsHeading = /^#{1,6}\s/.test(lines[i]!.trim());
			break;
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? '';
		if (lastIsHeading && i > lastNonEmpty) continue; // phantom trailing blanks
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
	for (const line of contentLinesAfterFrontmatter(text)) {
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

/** Lines of `text` with any leading YAML frontmatter (first `---` fence)
 *  removed, so content-type guessing ignores metadata properties. */
function contentLinesAfterFrontmatter(text: string): string[] {
	const lines = text.split('\n');
	const first = lines[0]?.trim() ?? '';
	if (first !== '---' && first !== '...') return lines;
	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? '';
		if (trimmed === '---' || trimmed === '...') {
			return lines.slice(i + 1);
		}
	}
	return lines;
}

/** `text` without any leading YAML frontmatter block. Returns the text
 *  unchanged when it does not start with a `---`/`...` fence. Used to keep
 *  the book's metadata out of the rendered note (it is plugin data, not
 *  readable content) so a note with frontmatter renders like a plain one. */
export function stripYamlFrontmatter(text: string): string {
	const lines = text.split('\n');
	const first = lines[0]?.trim() ?? '';
	if (first !== '---' && first !== '...') return text;
	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? '';
		if (trimmed === '---' || trimmed === '...') {
			return lines.slice(i + 1).join('\n');
		}
	}
	return text;
}

/** Terminate block-level render content with a blank line. Generic hardening
 *  against the EOF-boundary quirk class of MarkdownRenderer.render (the last
 *  block losing its context when the content does not end with an empty
 *  line); the appended blank line itself renders nothing. */
export function ensureTrailingBlankLine(text: string): string {
	return text.replace(/\n*$/, '\n\n');
}

/** Expand leading tabs of list-continuation lines that fall short of their
 *  parent marker's content column. A tab expands to the next multiple-of-4
 *  column, so under a wide marker (`100. ` = 5 columns) a tab-indented
 *  continuation stops one column short: it drops out of the list and, with
 *  4+ columns of indent, becomes an indented code block (literal `*` and
 *  backticks on screen). Obsidian's own parser is lenient here and renders
 *  the line as a continuation — the reading view shows a bullet while the
 *  plugin's MarkdownRenderer.render shows raw text. The lift rewrites the
 *  line's leading whitespace to exactly the anchor marker's content column,
 *  which is the interpretation the user already sees while editing.
 *
 *  Deliberately narrow — everything else is untouched by design:
 *  - lines whose tab-stop column already reaches the content column (valid
 *    continuations, nested lists, code blocks inside items) are not moved —
 *    their indent selects nesting/code level and must not change;
 *  - fenced code (``` / ~~~) is skipped whole — leading tabs there are
 *    literal content;
 *  - the anchor is the nearest indent-0 list marker within the last 10
 *    non-blank lines; the scan aborts at headings and at code-context lines
 *    (non-marker lines indented 4+ columns), so standalone indented code
 *    blocks and tab-led code after a paragraph stay raw;
 *  - only lines that themselves start with a list marker after their tab
 *    indent are candidates (the observed continuation-bullet shape);
 *  - unordered anchors are accepted but their content column (2) is below
 *    any tab stop, so those continuations pass through unchanged. */
export function normalizeListTabs(text: string): string {
	const lines = text.split('\n');
	let fenceChar = '';
	let fenceLen = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const trimmed = line.trim();
		const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
		if (fenceChar !== '') {
			// Inside a fence: only a matching closing fence ends the skip.
			if (fenceMatch && fenceMatch[0]?.[0] === fenceChar && (fenceMatch[0]?.length ?? 0) >= fenceLen && trimmed === fenceMatch[0]) {
				fenceChar = '';
				fenceLen = 0;
			}
			continue;
		}
		if (fenceMatch) {
			fenceChar = fenceMatch[0]?.[0] ?? '';
			fenceLen = fenceMatch[0]?.length ?? 0;
			continue;
		}
		const leadMatch = /^([ \t]+)(\S.*)$/.exec(line);
		if (!leadMatch) continue;
		const lead = leadMatch[1] ?? '';
		if (!lead.includes('\t')) continue;
		const rest = leadMatch[2] ?? '';
		// Candidates are continuation bullets/ordered items only.
		if (!/^([-*+]|\d{1,9}[.)])[ \t]/.test(rest)) continue;
		// Tab-stop column of the line's leading whitespace.
		let col = 0;
		for (const ch of lead) col = ch === '\t' ? (Math.floor(col / 4) + 1) * 4 : col + 1;
		// Anchor: nearest indent-0 list marker within the last 10 non-blank
		// lines. Bullets and paragraph text between the anchor and this line
		// are skipped; headings and code-context lines abort the lift.
		let anchorCol = -1;
		let nonBlank = 0;
		for (let j = i - 1; j >= 0 && nonBlank < 10 && anchorCol < 0; j--) {
			const prev = lines[j] ?? '';
			if (prev.trim().length === 0) continue;
			nonBlank++;
			let prevCol = 0;
			for (const ch of /^([ \t]*)/.exec(prev)?.[1] ?? '') {
				prevCol = ch === '\t' ? (Math.floor(prevCol / 4) + 1) * 4 : prevCol + 1;
			}
			const ordered = /^[ \t]*(\d{1,9}[.)])([ \t]+)/.exec(prev);
			const unordered = ordered ? null : /^[ \t]*([-*+])([ \t]+)/.exec(prev);
			if (ordered && prevCol === 0) {
				anchorCol = (ordered[1]?.length ?? 0) + (ordered[2]?.length ?? 1);
				break;
			}
			if (unordered && prevCol === 0) {
				anchorCol = (unordered?.[1]?.length ?? 1) + (unordered?.[2]?.length ?? 1);
				break;
			}
			// Indented list bullets (including already-lifted continuations)
			// stay in list context — keep scanning for the anchor above them.
			if (ordered || unordered) continue;
			if (prevCol >= 4) break; // indented code run — not list context
			if (/^#{1,6}[ \t]/.test(prev.trim())) break; // heading breaks the list
			// paragraph text — keep scanning
		}
		if (anchorCol < 0 || anchorCol <= col) continue;
		lines[i] = `${' '.repeat(anchorCol)}${rest}`;
	}
	return lines.join('\n');
}

/** First non-empty line's type: 'h1'..'h6' or 'text'. */
export function guessFirstType(text: string): string {
	for (const line of contentLinesAfterFrontmatter(text)) {
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
