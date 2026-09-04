import { App, AbstractInputSuggest, TFile, prepareFuzzySearch } from 'obsidian';

/**
 * Type-ahead note picker for the inline code-block link editor. Wraps the
 * input element created by the code-block processor in Obsidian's standard
 * `AbstractInputSuggest`, so while typing the user sees vault notes ranked by
 * the same fuzzy search as the native `[[` autocomplete and can pick one
 * instead of typing the link by hand.
 *
 * The input holds the raw source line (`[[Target]]`, `[[Target|Alias]]` or
 * `[Text](target)`). Suggestions match the *link target* extracted from that
 * line; picking one rewrites the line in the same style, keeping any alias or
 * link text.
 */

type OnPick = (built: string) => void;

/** Extract the link target from the raw source line stored in the input. */
function extractLinkTarget(line: string): string {
	const wikilink = line.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
	if (wikilink) return (wikilink[1] ?? wikilink[2] ?? '').trim();
	const mdLink = line.match(/^\[[^\]]*\]\(([^)]*)\)$/);
	if (mdLink) return (mdLink[1] ?? '').trim();
	return line.trim();
}

/** Rebuild the source line after a note was picked, keeping the line format
 *  (wikilink vs markdown link) and any alias / link text. */
function buildLinkFor(original: string, newTarget: string): string {
	const wikilink = original.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
	if (wikilink) {
		return wikilink[2] !== undefined
			? `[[${newTarget}|${wikilink[2]}]]`
			: `[[${newTarget}]]`;
	}
	const mdLink = original.match(/^\[([^\]]*)\]\([^)]*\)$/);
	if (mdLink) {
		return `[${mdLink[1] ?? ''}](${newTarget})`;
	}
	return `[[${newTarget}]]`;
}

export class CodeBlockLinkSuggest extends AbstractInputSuggest<TFile> {
	private popoverOpen = false;

	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		private readonly onPick: OnPick,
	) {
		super(app, input);
	}

	/** Whether the suggestion popover is currently showing. Callers use this
	 *  to keep Enter/Escape/blur handling from fighting the popover. */
	isOpen(): boolean {
		return this.popoverOpen;
	}

	open(): void {
		this.popoverOpen = true;
		super.open();
	}

	close(): void {
		this.popoverOpen = false;
		super.close();
	}

	/** Pick the selected note: rewrite the input with the new link and commit
	 *  immediately (the inline editor reads back `input.value` on save). */
	selectSuggestion(file: TFile): void {
		const target = file.path.replace(/\.md$/, '');
		const built = buildLinkFor(this.input.value, target);
		this.setValue(built);
		this.onPick(built);
	}

	protected getSuggestions(query: string): TFile[] {
		const q = extractLinkTarget(query);
		if (!q) return [];
		const search = prepareFuzzySearch(q);
		const scored: { file: TFile; score: number }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const res = search(file.basename);
			if (res) scored.push({ file, score: res.score });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, 20).map((s) => s.file);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.basename);
		const folder = file.parent?.path;
		if (folder) el.createSpan({ cls: 'book-view-codeblock-suggest-path', text: folder });
	}
}