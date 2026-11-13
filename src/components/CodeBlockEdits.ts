import type { Editor, MarkdownPostProcessorContext } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { parseCodeBlockLinks, type RawCodeBlockLink } from './CodeBlockParser';

export function locateCodeBlock(editor: Editor, ctx: MarkdownPostProcessorContext, el: HTMLElement, source: string) {
	const section = ctx.getSectionInfo(el);
	if (!section || section.lineStart < 0 || section.lineEnd >= editor.lineCount()) return;

	const fence = /^( {0,3})(`{3,}|~{3,})\s*book-view\s*$/.exec(editor.getLine(section.lineStart));
	if (!fence) return;
	const closing = editor.getLine(section.lineEnd).trim();
	const marker = fence[2]!;
	if (closing.length < marker.length || [...closing].some((char) => char !== marker[0])) return;

	const from = { line: section.lineStart + 1, ch: 0 };
	const to = { line: section.lineEnd, ch: 0 };
	const body = editor.getRange(from, to);
	const indent = fence[1]!;
	const unindented = body.split('\n').map((line) => {
		let spaces = 0;
		while (spaces < indent.length && line[spaces] === ' ') spaces++;
		return line.slice(spaces);
	}).join('\n');
	const rendered = source.replace(/\r\n/g, '\n');
	if (body !== rendered && body !== rendered + '\n' &&
		unindented !== rendered && unindented !== rendered + '\n') return;

	return {
		editor,
		body,
		indent,
		line: section.lineStart,
		replace: (value: string) => editor.replaceRange(value, from, to),
		replaceKeepingScroll: (value: string) => replaceKeepingScroll(editor, editor.posToOffset(from), body, value),
	};
}

function replaceKeepingScroll(editor: Editor, offset: number, before: string, after: string): void {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = before.length;
	let newEnd = after.length;
	while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) {
		end--;
		newEnd--;
	}
	const from = offset + start;
	const to = offset + end;
	const insert = after.slice(start, newEnd);
	const cm = (editor as Editor & { cm?: EditorView }).cm;
	if (cm?.scrollSnapshot) {
		if (cm.state.readOnly) return;
		const changes = cm.state.changes({ from, to, insert });
		// Let CodeMirror keep its viewport anchor while replacing the preview widget.
		cm.dispatch({ changes, effects: cm.scrollSnapshot().map(changes), userEvent: 'input.drop' });
	} else {
		editor.replaceRange(insert, editor.offsetToPos(from), editor.offsetToPos(to));
	}
}

/** Refill the existing link slots, keeping all text between them in place. */
export function reorderCodeBlockLinks(body: string, from: number, to: number): string {
	const links = parseCodeBlockLinks(body, true);
	if (!links[from] || !links[to] || from === to) return body;
	const tokens = links.map(({ offset, end }) => body.slice(offset, end));
	tokens.splice(to, 0, tokens.splice(from, 1)[0]!);
	let cursor = 0;
	const parts = links.map(({ offset, end }, index) => {
		const part = body.slice(cursor, offset) + tokens[index];
		cursor = end;
		return part;
	});
	return parts.join('') + body.slice(cursor);
}

export function insertCodeBlockLink(body: string, after: number, link: string, indent: string): string {
	const eol = body.includes('\r\n') ? '\r\n' : '\n';
	if (after === -1) return indent + link + eol + body;
	const links = parseCodeBlockLinks(body, true);
	const anchor = links[after];
	if (!anchor) return body;
	const next = links[after + 1];
	const lineBreak = body.indexOf('\n', anchor.end);
	if (next && (lineBreak === -1 || next.offset < lineBreak)) {
		return body.slice(0, anchor.end) + eol + indent + link + eol + indent + body.slice(anchor.end);
	}
	const end = lineBreak < 0 ? body.length : lineBreak - (body[lineBreak - 1] === '\r' ? 1 : 0);
	return body.slice(0, end) + eol + indent + link + body.slice(end);
}

/** Remove the whole line when it contains only the selected link. */
export function removeCodeBlockLink(body: string, { offset, end }: RawCodeBlockLink): string {
	const lineStart = body.lastIndexOf('\n', offset - 1) + 1;
	const lineBreak = body.indexOf('\n', end);
	const lineEnd = lineBreak === -1 ? body.length : lineBreak;
	if (!body.slice(lineStart, offset).trim() && !body.slice(end, lineEnd).trim()) {
		return body.slice(0, lineStart) + body.slice(lineBreak === -1 ? lineEnd : lineBreak + 1);
	}
	return body.slice(0, offset) + body.slice(end);
}
