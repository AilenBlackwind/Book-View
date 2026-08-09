/**
 * Pure text-level content analysis: height estimation and heading detection.
 * No DOM, no Obsidian imports — safe to unit-test in isolation.
 */

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
		if (/^>\s?\[!/.test(trimmed)) {
			estimated += 48; // callout header
			continue;
		}
		if (/^(-|\*|\+|\d+\.)\s/.test(trimmed) || trimmed.startsWith('>')) {
			estimated += 26;
			continue;
		}
		if (/!\[.*?\]\(.*?\)|!\[\[.*?\]\]/.test(trimmed)) {
			estimated += 300;
			continue;
		}
		estimated += Math.ceil(trimmed.length / 85) * 24;
	}

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
