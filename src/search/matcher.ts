export interface SearchHit {
	filePath: string;
	/** Zero-based line number. */
	line: number;
	/** Zero-based character offset of the match within the line. */
	column: number;
	lineText: string;
	match: string;
	/** Ordinal of this hit within its file (0-based), in document order. Used
	 *  to highlight the exact occurrence in the rendered section DOM. */
	index: number;
}

export interface SearchInput {
	path: string;
	content: string;
}

export interface SearchOptions {
	caseSensitive?: boolean;
	maxResults?: number;
}

/**
 * Pure line scanner over raw file content. Split out of the searcher so the
 * line/column bookkeeping is unit-testable without an Obsidian `App`.
 */
export function searchLines(
	inputs: readonly SearchInput[],
	query: string,
	options: SearchOptions = {},
): SearchHit[] {
	const { caseSensitive = false, maxResults = 200 } = options;
	const hits: SearchHit[] = [];
	const q = query.trim();
	if (!q) return hits;

	const needle = caseSensitive ? q : q.toLowerCase();

	for (const input of inputs) {
		if (hits.length >= maxResults) break;
		const content = input.content ?? '';
		if (!content) continue;

		let lineStart = 0;
		let lineNo = 0;
		let fileHit = 0;
		while (lineStart <= content.length && hits.length < maxResults) {
			const newlineIdx = content.indexOf('\n', lineStart);
			const lineEnd = newlineIdx === -1 ? content.length : newlineIdx;
			const raw = content.slice(lineStart, lineEnd);
			// Strip a trailing CR so CRLF files report clean columns.
			const lineText = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
			const hay = caseSensitive ? lineText : lineText.toLowerCase();

			let col = hay.indexOf(needle);
			while (col !== -1) {
				hits.push({
					filePath: input.path,
					line: lineNo,
					column: col,
					lineText,
					match: lineText.slice(col, col + q.length),
					index: fileHit,
				});
				fileHit++;
				if (hits.length >= maxResults) break;
				col = hay.indexOf(needle, col + q.length);
			}

			if (newlineIdx === -1) break;
			lineStart = newlineIdx + 1;
			lineNo++;
		}
	}

	return hits;
}
