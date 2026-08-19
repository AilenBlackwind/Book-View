import { describe, it, expect } from 'vitest';
import { SectionLayout, type Anchor, type SectionLayoutHost } from '../src/components/SectionLayout';
import type { SectionData } from '../src/components/SectionPool';
import type { FoldMode } from '../src/utils/fold';

const FALLBACK = 40;

interface Spec {
	path: string;
	offset: number;
	height: number;
	foldHeadingHeight?: number;
	fold?: FoldMode;
}

interface HostView {
	sections: Map<string, SectionData>;
	fileOrder: string[];
	getFoldMode(path: string): FoldMode;
}

function makeLayout(specs: Spec[]): { layout: SectionLayout; host: HostView } {
	const fileOrder: string[] = [];
	const sections = new Map<string, SectionData>();
	const foldOf = new Map<string, FoldMode>();
	for (const s of specs) {
		fileOrder.push(s.path);
		foldOf.set(s.path, s.fold ?? 'none');
		sections.set(s.path, {
			el: undefined as unknown as HTMLElement,
			component: null,
			offset: s.offset,
			height: s.height,
			startsWithHeading: false,
			endsWithHeading: false,
			firstType: 'text',
			lastType: 'text',
			foldHeadingHeight: s.foldHeadingHeight ?? 0,
			heavy: false,
			placeholder: false,
			renderGen: 0,
			mtime: 0,
			heightTrusted: true,
			wasHidden: false,
			deferralCount: 0,
			renderFailures: 0,
		});
	}
	const host: HostView = {
		sections,
		fileOrder,
		getFoldMode: (path: string): FoldMode => foldOf.get(path) ?? 'none',
	};
	return {
		layout: 		new SectionLayout(host as unknown as SectionLayoutHost),
		host,
	};
}

/** Reference implementation of the original linear findAnchorAt. */
function linearFindAnchor(host: HostView, scrollTop: number): Anchor | null {
	let lastIdx = -1;
	for (let i = 0; i < host.fileOrder.length; i++) {
		const path = host.fileOrder[i] ?? '';
		const data = host.sections.get(path);
		if (!data) continue;
		const foldMode = host.getFoldMode(path);
		if (foldMode === 'full') continue;
		lastIdx = i;
		const h = foldMode === 'heading'
			? (data.foldHeadingHeight > 0 ? data.foldHeadingHeight : FALLBACK)
			: data.height;
		if (data.offset + h > scrollTop) {
			return { idx: i, anchorOffset: scrollTop - data.offset };
		}
	}
	if (lastIdx >= 0) {
		const path = host.fileOrder[lastIdx] ?? '';
		const data = host.sections.get(path);
		if (data) {
			return { idx: lastIdx, anchorOffset: scrollTop - data.offset };
		}
	}
	return null;
}

function expectSameAcrossScroll(host: HostView, layout: SectionLayout, maxEnd: number): void {
	for (let st = -20; st <= maxEnd + 80; st++) {
		const got = layout.findAnchorAt(st);
		const want = linearFindAnchor(host, st);
		expect(got, `scrollTop=${st}`).toEqual(want);
	}
}

const endOf = (specs: Spec[]): number => specs[specs.length - 1]!.offset + specs[specs.length - 1]!.height;

describe('SectionLayout.findAnchorAt', () => {
	it('returns null for an empty book', () => {
		const { layout, host } = makeLayout([]);
		expect(layout.findAnchorAt(0)).toBeNull();
		expectSameAcrossScroll(host, layout, 0);
	});

	it('matches the linear scan for a single section, past the end included', () => {
		const specs: Spec[] = [{ path: 'a', offset: 0, height: 100 }];
		const { layout, host } = makeLayout(specs);
		expect(layout.findAnchorAt(0)).toEqual({ idx: 0, anchorOffset: 0 });
		expect(layout.findAnchorAt(99)).toEqual({ idx: 0, anchorOffset: 99 });
		// At/beyond the end the fallback anchors to the last section.
		expect(layout.findAnchorAt(100)).toEqual({ idx: 0, anchorOffset: 100 });
		expect(layout.findAnchorAt(150)).toEqual({ idx: 0, anchorOffset: 150 });
		expectSameAcrossScroll(host, layout, endOf(specs));
	});

	it('crosses section boundaries at the exact end', () => {
		const specs: Spec[] = [
			{ path: 'a', offset: 0, height: 100 },
			{ path: 'b', offset: 100, height: 200 },
			{ path: 'c', offset: 300, height: 50 },
		];
		const { layout, host } = makeLayout(specs);
		expect(layout.findAnchorAt(50)).toEqual({ idx: 0, anchorOffset: 50 });
		expect(layout.findAnchorAt(100)).toEqual({ idx: 1, anchorOffset: 0 });
		expect(layout.findAnchorAt(250)).toEqual({ idx: 1, anchorOffset: 150 });
		expect(layout.findAnchorAt(300)).toEqual({ idx: 2, anchorOffset: 0 });
		expect(layout.findAnchorAt(350)).toEqual({ idx: 2, anchorOffset: 50 });
		expectSameAcrossScroll(host, layout, endOf(specs));
	});

	it('skips fully hidden sections in the middle', () => {
		const specs: Spec[] = [
			{ path: 'a', offset: 0, height: 100 },
			{ path: 'b', offset: 100, height: 0, fold: 'full' },
			{ path: 'c', offset: 100, height: 50 },
			{ path: 'd', offset: 150, height: 80 },
		];
		const { layout, host } = makeLayout(specs);
		expect(layout.findAnchorAt(0)).toEqual({ idx: 0, anchorOffset: 0 });
		// b is hidden: the anchor jumps from a straight into c.
		expect(layout.findAnchorAt(100)).toEqual({ idx: 2, anchorOffset: 0 });
		expect(layout.findAnchorAt(149)).toEqual({ idx: 2, anchorOffset: 49 });
		expect(layout.findAnchorAt(150)).toEqual({ idx: 3, anchorOffset: 0 });
		expectSameAcrossScroll(host, layout, endOf(specs));
	});

	it('skips a run of fully hidden sections at the start', () => {
		const specs: Spec[] = [
			{ path: 'a', offset: 0, height: 0, fold: 'full' },
			{ path: 'b', offset: 0, height: 0, fold: 'full' },
			{ path: 'c', offset: 0, height: 60 },
			{ path: 'd', offset: 60, height: 40 },
		];
		const { layout, host } = makeLayout(specs);
		expect(layout.findAnchorAt(0)).toEqual({ idx: 2, anchorOffset: 0 });
		expect(layout.findAnchorAt(59)).toEqual({ idx: 2, anchorOffset: 59 });
		expect(layout.findAnchorAt(60)).toEqual({ idx: 3, anchorOffset: 0 });
		expectSameAcrossScroll(host, layout, endOf(specs));
	});

	it('anchors to heading stubs, using the fallback height before measurement', () => {
		const specs: Spec[] = [
			{ path: 'a', offset: 0, height: 40 },
			{ path: 'b', offset: 40, height: 0, fold: 'heading', foldHeadingHeight: 30 },
			{ path: 'c', offset: 70, height: 0, fold: 'heading', foldHeadingHeight: 0 },
			{ path: 'd', offset: 110, height: 0, fold: 'full' },
			{ path: 'e', offset: 110, height: 50 },
			{ path: 'f', offset: 160, height: 0, fold: 'full' },
		];
		const { layout, host } = makeLayout(specs);
		// b's stub end is 40+30=70; c is unmeasured so its stub end is 70+40=110.
		expect(layout.findAnchorAt(0)).toEqual({ idx: 0, anchorOffset: 0 });
		expect(layout.findAnchorAt(69)).toEqual({ idx: 1, anchorOffset: 29 });
		expect(layout.findAnchorAt(70)).toEqual({ idx: 2, anchorOffset: 0 });
		expect(layout.findAnchorAt(109)).toEqual({ idx: 2, anchorOffset: 39 });
		expect(layout.findAnchorAt(110)).toEqual({ idx: 4, anchorOffset: 0 });
		expectSameAcrossScroll(host, layout, endOf(specs));
	});

	it('returns null when every section is hidden', () => {
		const specs: Spec[] = [
			{ path: 'a', offset: 0, height: 0, fold: 'full' },
			{ path: 'b', offset: 0, height: 0, fold: 'full' },
		];
		const { layout, host } = makeLayout(specs);
		expect(layout.findAnchorAt(0)).toBeNull();
		expect(layout.findAnchorAt(50)).toBeNull();
		expectSameAcrossScroll(host, layout, 0);
	});

	it('handles a heading-only section and the scrolled-past-end fallback', () => {
		const specs: Spec[] = [{ path: 'a', offset: 0, height: 0, fold: 'heading', foldHeadingHeight: 25 }];
		const { layout, host } = makeLayout(specs);
		expect(layout.findAnchorAt(0)).toEqual({ idx: 0, anchorOffset: 0 });
		expect(layout.findAnchorAt(24)).toEqual({ idx: 0, anchorOffset: 24 });
		expect(layout.findAnchorAt(25)).toEqual({ idx: 0, anchorOffset: 25 });
		expect(layout.findAnchorAt(100)).toEqual({ idx: 0, anchorOffset: 100 });
		expectSameAcrossScroll(host, layout, endOf(specs));
	});

	it('matches the linear scan on a 2000-section book', () => {
		const specs: Spec[] = [];
		for (let i = 0; i < 2000; i++) {
			const height = 100 + (i % 7) * 20;
			specs.push({ path: `n${i}`, offset: specs.length > 0 ? specs[specs.length - 1]!.offset + specs[specs.length - 1]!.height : 0, height });
		}
		const { layout, host } = makeLayout(specs);
		const maxEnd = endOf(specs);
		for (let st = -20; st <= maxEnd + 80; st += 97) {
			const got = layout.findAnchorAt(st);
			const want = linearFindAnchor(host, st);
			expect(got, `scrollTop=${st}`).toEqual(want);
		}
	});
});
