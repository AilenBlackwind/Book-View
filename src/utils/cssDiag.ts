import { Notice } from 'obsidian';
import type BookViewPlugin from '../main';

export interface HasFinding {
	sheet: string;
	selector: string;
	severity: 'high' | 'medium';
}

/**
 * Diagnostic for the class of stylesheet rules that caused real, measured
 * style-recalc freezes on every section mount:
 *
 *     div:has(:is(h1, h2, h3, h4)):has(+ div > .callout[data-callout*="list"])
 *
 * A `:has()` whose subject is a broad element (a tag like `div`, or a heading)
 * and whose argument escapes the subject's own box (descendant or child) makes
 * Blink treat every matching subject AND its ancestors as potential has()
 * dependents. When content is inserted further down (a section mount), the
 * whole ancestor chain up to `.app-container` gets a style recalc — the 2.4s
 * "Affected by :has()" trace this plugin hit. Sibling-scoped `:has(+ x)` and
 * `:has(~ x)` are cheap: the dependency is confined to the adjacent siblings,
 * so they are intentionally not reported.
 *
 * The scan is pure string parsing of selectorText. It never touches the live
 * DOM, never runs querySelectorAll with :has(), and never forces layout, so
 * running it cannot itself trigger the invalidation it is looking for.
 */

/** Tags that match a large number of unrelated nodes in a document. */
const BROAD_TAGS = new Set([
	'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'section', 'article', 'header',
	'footer', 'nav', 'main', 'aside', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'form', 'button',
	'input', 'body',
]);

/** Container classes every reading/notes view has one of per note. */
const BROAD_CLASSES = new Set(['markdown-rendered', 'markdown-preview-view']);

/** Split a selector on top-level commas, respecting () and [] nesting. */
function splitTopLevel(sel: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < sel.length; i++) {
		const c = sel[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') depth--;
		else if (depth === 0 && c === ',') {
			parts.push(sel.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(sel.slice(start));
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** Positions of `:has(` … `)` spans in one selector, with their argument text. */
function findHasCalls(part: string): Array<{ subjectStart: number; arg: string }> {
	const out: Array<{ subjectStart: number; arg: string }> = [];
	const needle = ':has(';
	let idx = part.indexOf(needle);
	while (idx !== -1) {
		let depth = 0;
		for (let i = idx + needle.length; i < part.length; i++) {
			const c = part[i];
			if (c === '(') depth++;
			else if (c === ')') {
				if (depth === 0) {
					out.push({ subjectStart: idx, arg: part.slice(idx + needle.length, i) });
					break;
				}
				depth--;
			}
		}
		idx = part.indexOf(needle, idx + needle.length);
	}
	return out;
}

/** The compound selector immediately before `:has(`, as one token. */
function subjectBefore(part: string, subjectStart: number): string {
	let depth = 0;
	let i = subjectStart - 1;
	while (i >= 0) {
		const c = part[i];
		if (c === ')' || c === ']') { depth++; i--; continue; }
		if (c === '(' || c === '[') {
			if (depth > 0) depth--;
			i--;
			continue;
		}
		if (depth === 0 && (c === ' ' || c === '+' || c === '~' || c === '>')) break;
		i--;
	}
	return part.slice(i + 1, subjectStart).trim();
}

/** Heuristic: does this subject match many unrelated nodes in any document? */
function isBroadSubject(subject: string): boolean {
	const s = subject;
	if (!s) return false;
	if (s === '*') return true;
	// Bare type selector, e.g. `div`, `section`, `h2`.
	if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) {
		return BROAD_TAGS.has(s.toLowerCase());
	}
	// Type selector with attribute filter, e.g. `div[data-x]`.
	const typeAttr = /^([a-zA-Z][a-zA-Z0-9-]*)\[/.exec(s);
	if (typeAttr && BROAD_TAGS.has(typeAttr[1]!.toLowerCase())) return true;
	// Element groups like `:is(h1, h2, h3, h4)` and `:where(...)`.
	const group = /^:(is|where)\((.*)\)$/.exec(s);
	if (group) {
		return splitTopLevel(group[2]!).some((arg) => {
			const tag = arg.trim().split('[')[0]!.toLowerCase();
			return BROAD_TAGS.has(tag) || tag === '*';
		});
	}
	// Global per-note container classes.
	if (/^\.([a-zA-Z][a-zA-Z0-9-]*)(\.[a-zA-Z][a-zA-Z0-9-]*)*$/.test(s)) {
		return BROAD_CLASSES.has(s.split('.')[1]!.toLowerCase());
	}
	return false;
}

/**
 * Cost class for a :has() argument:
 *  - null: sibling-scoped (+ / ~) — cheap, not reported.
 *  - 'medium': child combinator (>) — invalidation confined to direct children.
 *  - 'high': descendant (bare compound or universal) — worst case, the one
 *    that spreads style recalc up the whole ancestor chain.
 */
function argSeverity(arg: string): 'high' | 'medium' | null {
	const a = arg.trim();
	if (!a) return null;
	const first = a[0];
	if (first === '+' || first === '~') return null;
	if (first === '>') return 'medium';
	return 'high';
}

function sheetLabel(sheet: CSSStyleSheet): string {
	const node = sheet.ownerNode;
	if (!node) return '(adopted stylesheet)';
	if (node instanceof HTMLLinkElement) {
		const name = node.href?.split('/').pop() ?? '';
		return `link:${name}`;
	}
	if (node instanceof HTMLStyleElement) {
		const cls = (node as HTMLElement).className?.trim() ?? '';
		return `<style>${cls ? `.${cls.replace(/\s+/g, '.')}` : ''}`;
	}
	if (node instanceof HTMLElement) return node.tagName.toLowerCase();
	return 'unknown';
}

/** Scan all readable stylesheets for expensive :has() selectors. */
export function scanHasPerformance(): HasFinding[] {
	const out: HasFinding[] = [];
	const seen = new Set<string>();

	const processSelector = (selector: string, sheetName: string) => {
		for (const part of splitTopLevel(selector)) {
			for (const call of findHasCalls(part)) {
				const subject = subjectBefore(part, call.subjectStart);
				if (!isBroadSubject(subject)) continue;
				const severity = argSeverity(call.arg);
				if (!severity) continue;
				const key = `${sheetName}\u0000${part}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ sheet: sheetName, selector: part, severity });
			}
		}
	};

	const walk = (ruleList: CSSRuleList, sheetName: string) => {
		for (const rule of Array.from(ruleList)) {
			const st = (rule as unknown as { selectorText?: string }).selectorText;
			if (typeof st === 'string' && st.includes(':has(')) {
				processSelector(st, sheetName);
			}
			const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules;
			if (nested) walk(nested, sheetName);
		}
	};

	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			// Unreadable from this origin (Obsidian's own app.css) — those have
			// no :has() in this app version anyway.
			continue;
		}
		walk(rules, sheetLabel(sheet));
	}

	return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

/** Pretty-print findings to the console for interactive inspection.
 *  Uses only debug/warn (allowed by the obsidian no-console rule). */
export function logHasFindings(findings: HasFinding[], force = false): void {
	if (findings.length === 0) {
		if (force) console.debug('[Book View] CSS :has() diagnostics: no expensive selectors found.');
		return;
	}
	for (const f of findings) {
		console.debug(`[Book View] ${f.severity} ${f.sheet} :: ${f.selector}`);
	}
	console.warn(
		`[Book View] ${findings.length} expensive :has() selector(s). These rules make Blink treat every matching element (and its ancestors) as a :has() dependent; when the book mounts a section, the whole ancestor chain gets a style recalc. Prefer sibling-scoped :has(+ x) / :has(~ x), or scope the subject to a non-broad class.`,
	);
}

let warnedOnce = false;

/**
 * One-time-per-session auto-warning shown on the first opened book. Gated by
 * the `cssHasWarningEnabled` setting. Reads nothing from the live layout.
 */
export function maybeWarnHasSelectors(plugin: BookViewPlugin): void {
	if (warnedOnce) return;
	warnedOnce = true;
	if (!plugin.settings.cssHasWarningEnabled) return;
	const findings = scanHasPerformance();
	const high = findings.filter((f) => f.severity === 'high').length;
	if (findings.length > 0) logHasFindings(findings, false);
	// Child-scoped :has(> x) is bounded and rarely a real problem; only warn
	// automatically when a descendant-scoped rule (the freeze class) is found.
	if (high === 0) return;
	const example = findings.find((f) => f.severity === 'high')!.selector;
	new Notice(
		`Book View: ${high} expensive :has() selector${high > 1 ? 's' : ''} in your themes/snippets — they can cause style-recalc freezes on every section mount (details in console). Example: ${example}`,
		15000,
	);
}