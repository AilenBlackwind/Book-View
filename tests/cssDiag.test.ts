import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { logHasFindings, scanHasPerformance } from '../src/utils/cssDiag';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CSS :has() diagnostics', () => {
	it('preserves theme attribution without snippet metadata and leaves anonymous styles unknown', () => {
		class Element { tagName = 'STYLE'; className = ''; }
		vi.stubGlobal('HTMLElement', Element);
		vi.stubGlobal('HTMLStyleElement', Element);
		vi.stubGlobal('HTMLLinkElement', class {});
		const theme = new Element();
		vi.stubGlobal('document', { styleSheets: [
			{ ownerNode: theme, cssRules: [{ selectorText: 'div:has(table)' }] },
			{ ownerNode: new Element(), cssRules: [{ selectorText: 'body:has(.editor)' }] },
		] });
		expect(scanHasPerformance({ customCss: { styleEl: theme } } as unknown as App)
			.map((finding) => finding.source)).toEqual(['theme', 'other']);
	});
	it('reports theme and plugin matches as debug information rather than snippet warnings', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
		logHasFindings([
			{ sheet: 'Minimal', selector: 'div:has(table)', source: 'theme', severity: 'high' },
			{ sheet: 'Kanban', selector: 'td:has(.editor)', source: 'plugin', severity: 'high' },
		]);
		expect(warn).not.toHaveBeenCalled();
		expect(debug).toHaveBeenLastCalledWith(expect.stringContaining('snippet=0, theme=1, plugin=1, other=0'));
	});

	it('warns about snippet candidates without claiming a measured slowdown', () => {
		vi.spyOn(console, 'debug').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		logHasFindings([{ sheet: 'snippet', selector: 'div:has(h1)', source: 'snippet', severity: 'high' }]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not measure style or layout cost'));
	});

	it('examines all branches of :has() and ignores disabled sheets', () => {
		class Element { tagName = 'STYLE'; className = ''; }
		vi.stubGlobal('HTMLElement', Element);
		vi.stubGlobal('HTMLStyleElement', Element);
		vi.stubGlobal('HTMLLinkElement', class {});
		const node = new Element();
		vi.stubGlobal('document', { styleSheets: [
			{ ownerNode: node, cssRules: [
				{ selectorText: 'div:has(+ .sibling, .descendant)' },
				{ selectorText: 'section:has(+ .sibling, > .child)' },
				{ selectorText: 'div:has(+ .sibling, ~ .other)' },
			] },
			{ disabled: true, ownerNode: node, cssRules: [{ selectorText: 'body:has(.anything)' }] },
		] });
		const findings = scanHasPerformance({ customCss: { styleEl: null, extraStyleEls: [node] } } as unknown as App);
		expect(findings.map(({ selector, severity, source }) => ({ selector, severity, source }))).toEqual([
			{ selector: 'div:has(+ .sibling, .descendant)', severity: 'high', source: 'snippet' },
			{ selector: 'section:has(+ .sibling, > .child)', severity: 'medium', source: 'snippet' },
		]);
	});
});
