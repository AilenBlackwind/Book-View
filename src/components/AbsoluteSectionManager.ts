import { App, Component, MarkdownRenderer, TFile } from 'obsidian';
import { ManifestLink } from './ManifestParser';

export const HEIGHT_PER_LINE = 25;

const FALLBACK_PX = 16;
const OVERSCAN_TOP = 2500;
const SCROLL_THRESHOLD = 1;

interface SectionData {
	el: HTMLElement;
	component: Component | null;
	offset: number;
	height: number;
	startsWithHeading: boolean;
	endsWithHeading: boolean;
	renderGen: number;
	mtime: number;
	heightTrusted: boolean;
}

interface HeightPersistence {
	get?: (path: string, mtime: number) => number | undefined;
	put?: (path: string, mtime: number, height: number) => void;
}

export class AbsoluteSectionManager {
	private scrollContainer: HTMLElement;
	private spacerEl: HTMLElement;
	private links: ManifestLink[];
	private app: App;
	private masterFile: TFile;
	private loadMargin: number;
	private persistence: HeightPersistence;

	private sections: Map<string, SectionData> = new Map();
	private fileOrder: string[] = [];
	private rawContent: Map<string, string> = new Map();
	private heightCache: Map<string, number> = new Map();
	private renderedDomCache: Map<string, HTMLElement> = new Map();
	private observer: IntersectionObserver;
	private sectionResizeObserver: ResizeObserver;
	private containerWidthObserver: ResizeObserver;
	private prevScrollTop = 0;
	private boundScrollHandler: (() => void) | null = null;
	private renderQueue: string[] = [];
	private activeRenderCount = 0;
	private maxConcurrent = 1;
	private coldStartTimer: number = 0;
	private lastScrollTop = 0;
	private lastContainerWidth = 0;
	private isAdjustingScroll = false;
	private pendingHeights: Map<string, number> = new Map();
	private pendingWidthChange = false;
	private rafId = 0;
	private destroyed = false;
	private idleTimer = 0;
	private lastUserScrollAt = 0;

	private static readonly DEBUG = true;

	private dbg(msg: string, ...args: unknown[]): void {
		if (!AbsoluteSectionManager.DEBUG) return;
		const w = window as unknown as { __bvLog?: string[] };
		const log = w.__bvLog ?? (w.__bvLog = []);
		log.push(`${new Date().toISOString().slice(11, 23)} ${msg} ${args.join(' ')}`);
		if (log.length > 2000) log.splice(0, log.length - 2000);
	}

	onHeightMeasured: ((path: string, estimated: number, actual: number) => void) | null = null;
	onSectionRendered: ((path: string, container: HTMLElement) => void) | null = null;

	constructor(
		scrollContainer: HTMLElement,
		links: ManifestLink[],
		app: App,
		masterFile: TFile,
		loadMargin: number = 800,
		persistence: HeightPersistence = {},
	) {
		this.scrollContainer = scrollContainer;
		this.links = links;
		this.app = app;
		this.masterFile = masterFile;
		this.loadMargin = loadMargin;
		this.persistence = persistence;

		this.scrollContainer.addClass('book-absolute-container');
		this.spacerEl = this.scrollContainer.createDiv({ cls: 'book-spacer' });

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const path = el.dataset.path;
					if (!path) continue;

					if (entry.isIntersecting) {
						this.enqueueRender(path);
					} else {
						this.unloadSection(path);
					}
				}
			},
			{
				root: this.scrollContainer,
				rootMargin: `${OVERSCAN_TOP}px 0px ${this.loadMargin}px 0px`,
				threshold: 0,
			},
		);

		this.sectionResizeObserver = new ResizeObserver((entries) => {
			const containerTop = this.scrollContainer.getBoundingClientRect().top;
			for (const entry of entries) {
				const el = entry.target as HTMLElement;
				const path = el.dataset.path;
				if (!path) continue;

				const newHeight = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
				if (newHeight <= 0) continue;

				const data = this.sections.get(path);
				if (!data) continue;
				// Ignore stale notifications delivered after unload.
				if (!data.component) continue;
				// Ignore sub-pixel churn: fractional fluctuations still trigger
				// scrollTop writes, and each write cancels an in-flight wheel tick.
				if (Math.abs(newHeight - data.height) < 2) continue;

				const relTop = el.getBoundingClientRect().top - containerTop;
				this.dbg('height-change', path.split('/').pop(), `${Math.round(data.height)} -> ${Math.round(newHeight)}`, relTop < 0 ? 'above' : 'below');
				this.pendingHeights.set(path, newHeight);
			}
			if (this.pendingHeights.size > 0) {
				this.scheduleUpdate();
			}
		});

		this.containerWidthObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const newWidth = entry.contentRect.width;
				if (this.lastContainerWidth !== 0 && Math.abs(newWidth - this.lastContainerWidth) > 2) {
					this.pendingWidthChange = true;
					this.scheduleUpdate();
				}
				this.lastContainerWidth = newWidth;
			}
		});
		this.containerWidthObserver.observe(this.scrollContainer);

		this.boundScrollHandler = () => {
			const newTop = this.scrollContainer.scrollTop;
			if (this.isAdjustingScroll) {
				this.isAdjustingScroll = false;
				this.dbg('adjust-consumed', Math.round(newTop));
			} else {
				this.lastUserScrollAt = Date.now();
			}
			const delta = Math.abs(newTop - this.lastScrollTop);
			if (delta > 2000) {
				this.renderQueue = this.renderQueue.filter((p) => {
					const d = this.sections.get(p);
					if (!d || d.component) return false;
					const rect = d.el.getBoundingClientRect();
					return Math.abs(rect.top) < 4000;
				});
			}
			this.lastScrollTop = newTop;
			this.prevScrollTop = newTop;
		};
		this.scrollContainer.addEventListener('scroll', this.boundScrollHandler, { passive: true });

		this.coldStartTimer = window.setTimeout(() => {
			this.maxConcurrent = 2;
			this.drainQueue();
		}, 200);
	}

	render(): void {
		const readPromises: Promise<void>[] = [];
		for (const link of this.links) {
			if (link.type === 'broken') {
				const el = this.spacerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '❌ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Note not found: ${link.display}` });
				continue;
			}

			if (link.type === 'empty') {
				const el = this.spacerEl.createDiv({ cls: 'book-section-warning' });
				el.createSpan({ text: '⚠️ ' });
				el.createSpan({ cls: 'book-warning-text', text: `Empty note: ${link.file.path}` });
				continue;
			}

			const file = link.file;
			const path = file.path;

			const el = this.spacerEl.createDiv({
				cls: 'book-section-placeholder book-section-absolute',
				attr: { 'data-path': path },
			});

			const mtime = file.stat.mtime;
			const cached = this.heightCache.get(path) ?? this.persistence.get?.(path, mtime);
			const estimated = cached ?? 35;

		const data: SectionData = {
			el,
			component: null,
			offset: 0,
			height: estimated,
			startsWithHeading: false,
			endsWithHeading: false,
			renderGen: 0,
			mtime,
			heightTrusted: cached !== undefined,
		};
			this.sections.set(path, data);
			this.fileOrder.push(path);

			const p = this.app.vault.cachedRead(file).then((content) => {
				this.rawContent.set(path, content);
				const est = cached ?? this.estimateHeight(content);
				data.height = est;
				if (!cached) {
					this.heightCache.set(path, est);
				}
				data.startsWithHeading = AbsoluteSectionManager.startsWithHeading(content);
				data.endsWithHeading = AbsoluteSectionManager.endsWithHeading(content);
			});
			readPromises.push(p);

			this.observer.observe(el);
		}

		this.recalcOffsets();
		void Promise.allSettled(readPromises).then(() => {
			this.scheduleUpdate();
		});
		this.schedulePreRender();
	}

	private estimateHeight(text: string): number {
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

	private static startsWithHeading(text: string): boolean {
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			return /^#{1,6}\s/.test(trimmed);
		}
		return false;
	}

	private static endsWithHeading(text: string): boolean {
		const lines = text.split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const trimmed = lines[i]?.trim() ?? '';
			if (trimmed.length === 0) continue;
			return /^#{1,6}\s/.test(trimmed);
		}
		return false;
	}

	private async loadSection(path: string): Promise<void> {
		const data = this.sections.get(path);
		if (!data || data.component) return;

		const cachedDom = this.renderedDomCache.get(path);
		if (cachedDom) {
			this.dbg('load-cached', path.split('/').pop());
			this.renderedDomCache.delete(path);
			data.el.appendChild(cachedDom);
			data.component = new Component();
			this.sectionResizeObserver.observe(data.el);
			return;
		}

		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return;

		const gen = data.renderGen + 1;
		data.renderGen = gen;
		this.dbg('load-fresh', path.split('/').pop());

		const content = this.rawContent.get(path) ?? await this.app.vault.cachedRead(file);
		if (this.destroyed || data.renderGen !== gen) return;

		data.startsWithHeading = AbsoluteSectionManager.startsWithHeading(content);
		data.endsWithHeading = AbsoluteSectionManager.endsWithHeading(content);

		// Render into a detached container: partial output is never visible
		// and unloadSection cannot cache half-rendered DOM mid-flight.
		const renderContainer = createDiv({
			cls: 'markdown-rendered markdown-preview-view',
		});

		const component = new Component();
		data.component = component;
		await MarkdownRenderer.render(this.app, content, renderContainer, path, component);

		if (this.destroyed || data.renderGen !== gen || data.component !== component) return;

		data.el.empty();
		data.el.appendChild(renderContainer);
		this.sectionResizeObserver.observe(data.el);
		this.onSectionRendered?.(path, renderContainer);
		this.scheduleUpdate();
	}

	private unloadSection(path: string): void {
		const data = this.sections.get(path);
		if (!data || !data.component) return;

		this.dbg('unload', path.split('/').pop());
		this.sectionResizeObserver.unobserve(data.el);

		const rendered = data.el.querySelector('.markdown-rendered');
		if (rendered) {
			this.renderedDomCache.set(path, rendered as HTMLElement);
		}

		data.component.unload();
		data.component = null;
		// Invalidate any in-flight render for this section.
		data.renderGen++;
		data.el.empty();
	}

	private enqueueRender(path: string): void {
		if (this.destroyed) return;
		const data = this.sections.get(path);
		if (!data || data.component) return;
		if (this.renderQueue.includes(path)) return;
		this.renderQueue.push(path);
		this.drainQueue();
	}

	private drainQueue(): void {
		if (this.destroyed) return;
		while (this.activeRenderCount < this.maxConcurrent && this.renderQueue.length > 0) {
			const path = this.renderQueue.shift()!;
			this.activeRenderCount++;
			void this.loadSection(path).finally(() => {
				this.activeRenderCount--;
				this.drainQueue();
			});
		}
	}

	private schedulePreRender(): void {
		if (this.destroyed) return;
		window.clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => void this.preRenderNext(), 60);
	}

	private preRenderNext(): void {
		if (this.destroyed) return;
		// Never pre-measure while the user is actively scrolling: the resulting
		// height corrections would land in the middle of wheel/touch gestures.
		if (Date.now() - this.lastUserScrollAt < 300) {
			this.schedulePreRender();
			return;
		}
		const path = this.nextPreRenderPath();
		if (!path) return;
		this.dbg('pre-render', path.split('/').pop());
		void this.loadSection(path).then(() => {
			window.setTimeout(() => {
				if (this.destroyed) return;
				const data = this.sections.get(path);
				if (data?.component) {
					const rect = data.el.getBoundingClientRect();
					const crect = this.scrollContainer.getBoundingClientRect();
					const inZone = rect.bottom > crect.top - OVERSCAN_TOP && rect.top < crect.bottom + this.loadMargin;
					// Park the measured DOM in the cache so memory stays bounded.
					if (!inZone) this.unloadSection(path);
				}
				this.schedulePreRender();
			}, 80);
		});
	}

	private nextPreRenderPath(): string | null {
		const anchor = this.findAnchorAt(this.scrollContainer.scrollTop);
		const center = anchor?.idx ?? 0;
		for (let step = 0; step < this.fileOrder.length; step++) {
			const candidates = [center - step, center + step];
			for (const idx of candidates) {
				if (idx < 0 || idx >= this.fileOrder.length) continue;
				const path = this.fileOrder[idx];
				if (!path) continue;
				const data = this.sections.get(path);
				if (!data || data.component) continue;
				if (data.heightTrusted) continue;
				if (this.renderedDomCache.has(path)) continue;
				return path;
			}
		}
		return null;
	}

	private gapBetween(prevPath: string, nextPath: string): number {
		const prevData = this.sections.get(prevPath);
		const nextData = this.sections.get(nextPath);
		if (!prevData || !nextData) return FALLBACK_PX;

		const lastA = prevData.el.querySelector('.markdown-rendered')?.lastElementChild;
		const firstB = nextData.el.querySelector('.markdown-rendered')?.firstElementChild;

		const isAHeader = lastA
			? /^H[1-6]$/.test(lastA.tagName)
			: prevData.endsWithHeading;

		const isBHeader = firstB
			? /^H[1-6]$/.test(firstB.tagName)
			: nextData.startsWithHeading;

		// heading → heading: 0
		if (isAHeader && isBHeader) return 0;

		const style = getComputedStyle(this.scrollContainer);
		const pSpacing = AbsoluteSectionManager.parseCssPx(
			style.getPropertyValue('--p-spacing'), FALLBACK_PX,
		);

		if (isBHeader) {
			const hSpacing = AbsoluteSectionManager.parseCssPx(
				style.getPropertyValue('--heading-spacing'), FALLBACK_PX,
			);
			return Math.max(pSpacing, hSpacing);
		}

		return pSpacing;
	}

	private static parseCssPx(val: string | undefined, fallback: number): number {
		if (!val) return fallback;
		const m = val.trim().match(/^([\d.]+)(px|rem|em)?$/);
		if (!m) return fallback;
		const num = parseFloat(m[1] ?? '');
		const unit = m[2];
		if (unit === 'rem' || unit === 'em') {
			return num * parseFloat(getComputedStyle(document.body).fontSize);
		}
		return num;
	}

	private recalcOffsets(): void {
		let offset = 0;

		for (let i = 0; i < this.fileOrder.length; i++) {
			const path = this.fileOrder[i] ?? '';
			const data = this.sections.get(path);
			if (!data) break;

			data.offset = offset;
			data.el.style.top = `${offset}px`;
			offset += data.height;

			if (i + 1 < this.fileOrder.length) {
				const nextPath = this.fileOrder[i + 1] ?? '';
				offset += this.gapBetween(path, nextPath);
			}
		}

		this.spacerEl.style.height = `${offset}px`;
	}

	private findAnchorAt(scrollTop: number): { idx: number; anchorOffset: number } | null {
		let lastIdx = -1;
		for (let i = 0; i < this.fileOrder.length; i++) {
			const data = this.sections.get(this.fileOrder[i] ?? '');
			if (!data) continue;
			lastIdx = i;
			if (data.offset + data.height > scrollTop) {
				// Either inside this section or in the gap right above it
				// (negative anchorOffset). Gaps are constant across a recalc,
				// so relative compensation stays exact.
				return { idx: i, anchorOffset: scrollTop - data.offset };
			}
		}
		if (lastIdx >= 0) {
			const data = this.sections.get(this.fileOrder[lastIdx] ?? '');
			if (data) {
				return { idx: lastIdx, anchorOffset: scrollTop - data.offset };
			}
		}
		return null;
	}

	private restoreScrollAt(anchor: { idx: number; anchorOffset: number } | null, currentScrollTop: number): void {
		if (!anchor) return;
		const data = this.sections.get(this.fileOrder[anchor.idx] ?? '');
		if (!data) return;
		const target = data.offset + anchor.anchorOffset;
		const delta = Math.abs(target - currentScrollTop);
		if (delta > SCROLL_THRESHOLD) {
			this.isAdjustingScroll = true;
			this.dbg('compensate', `${Math.round(currentScrollTop)} -> ${Math.round(target)}`, `delta=${Math.round(target - currentScrollTop)}`);
			this.scrollContainer.scrollTop = target;
		}
	}

	private scheduleUpdate(): void {
		if (this.rafId) return;
		this.rafId = window.requestAnimationFrame(() => {
			this.rafId = 0;
			this.processUpdates();
		});
	}

	private processUpdates(): void {
		const freshScrollTop = this.scrollContainer.scrollTop;
		const anchor = this.findAnchorAt(freshScrollTop);
		this.dbg('update', `pending=${this.pendingHeights.size}`, anchor ? `anchor=${anchor.idx}@${Math.round(anchor.anchorOffset)}` : 'anchor=null', `scrollTop=${Math.round(freshScrollTop)}`);

		if (this.pendingWidthChange) {
			this.pendingWidthChange = false;
			for (const [path, data] of this.sections) {
				if (!data.el.querySelector('.markdown-rendered')) {
					const content = this.rawContent.get(path);
					if (content) {
						data.height = this.estimateHeight(content);
					}
					this.heightCache.delete(path);
					data.heightTrusted = false;
				}
			}
		}

		if (this.pendingHeights.size > 0) {
			for (const [path, newHeight] of this.pendingHeights) {
				const data = this.sections.get(path);
				if (!data) continue;
				data.height = newHeight;
				this.heightCache.set(path, newHeight);
				this.persistence.put?.(path, data.mtime, newHeight);
				data.heightTrusted = true;
			}
			this.pendingHeights.clear();
		}

		this.recalcOffsets();
		this.restoreScrollAt(anchor, freshScrollTop);
	}

	getOffset(path: string): number {
		return this.sections.get(path)?.offset ?? 0;
	}

	getAllOffsets(): Map<string, number> {
		const result = new Map<string, number>();
		for (const [path, data] of this.sections) {
			result.set(path, data.offset);
		}
		return result;
	}

	refreshSection(path: string): void {
		const data = this.sections.get(path);
		if (!data) return;

		this.sectionResizeObserver.unobserve(data.el);

		if (data.component) {
			data.component.unload();
			data.component = null;
		}

		this.rawContent.delete(path);
		this.renderedDomCache.delete(path);
		const file = this.app.vault.getFileByPath(path);
		if (file instanceof TFile) {
			data.mtime = file.stat.mtime;
		}
		// Keep the last measured height and heading flags until the re-render
		// produces new measurements: collapsing the height here would shift
		// everything below without any scroll compensation.
		data.renderGen++;
		data.el.empty();
		void this.loadSection(path);
	}

	markDirty(path: string): void {
		this.refreshSection(path);
	}

	destroy(): void {
		this.destroyed = true;
		this.renderQueue.length = 0;
		if (this.rafId) {
			cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
		this.observer.disconnect();
		this.sectionResizeObserver.disconnect();
		this.containerWidthObserver.disconnect();
		if (this.boundScrollHandler) {
			this.scrollContainer.removeEventListener('scroll', this.boundScrollHandler);
		}
		window.clearTimeout(this.coldStartTimer);
		window.clearTimeout(this.idleTimer);
		for (const [, data] of this.sections) {
			data.component?.unload();
		}
		this.sections.clear();
		this.fileOrder = [];
		this.heightCache.clear();
		this.pendingHeights.clear();
		this.renderedDomCache.clear();
		this.rawContent.clear();
	}
}
