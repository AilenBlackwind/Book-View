import { TocState } from './state';
import { TocSpy } from './spy';
import { HEIGHT_PER_LINE } from './types';
import { guardedScrollWrite } from '../components/ScrollGuard';

/** Click-navigation to a ToC entry: jump the book to the heading, settle the
 *  scroll once async renders stop shifting the layout, and flash a highlight
 *  on the target. */
export class TocNavigator {
	constructor(private state: TocState, private spy: TocSpy) {}

	async scrollToHeading(entryIndex: number): Promise<void> {
		const s = this.state;
		const entry = s.entries[entryIndex];
		if (!entry || !s.positionSource) return;

		// Cancel any in-flight navigation: each new click supersedes the
		// previous one.  The old async loop will see the stale generation
		// and bail out at its next checkpoint.
		const gen = ++s.navigationGeneration;

		// If a previous navigation is still in-flight, let one frame pass
		// so its generation check fires and it bails, then proceed.
		if (s.navigating) {
			await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
			if (s.navigationGeneration !== gen) return;
		}

		s.navigating = true;
		s.isJumping = true;
		try {
			const sectionOffset = s.positionSource.getOffset(entry.file.path) ?? 0;
			const estimatedY = sectionOffset + entry.line * HEIGHT_PER_LINE;

			guardedScrollWrite(s.scrollContainer, () => {
				s.scrollContainer.scrollTo({ top: Math.max(0, estimatedY - 20), behavior: 'auto' });
			});

			let targetHeading: Element | null = s.positionSource.resolveHeadingEl?.(entry) ?? null;
			if (!targetHeading) {
				const placeholder = s.scrollContainer.querySelector(
					`.book-section-placeholder[data-path="${entry.file.path}"]`,
				);
				if (placeholder instanceof HTMLElement) {
					for (let attempt = 0; attempt < 30; attempt++) {
						const headings = placeholder.querySelectorAll('h1, h2, h3, h4, h5, h6');
						targetHeading = headings[entry.fileHeadingIndex] ?? null;
						if (targetHeading) break;
						await new Promise<void>((resolve) =>
							window.requestAnimationFrame(() => resolve()),
						);
					}
				} else if (s.positionSource?.resolveHeadingEl) {
					// A content-based host (e.g. a reading view) lazy-renders the
					// note: the estimated scroll just moved the viewport, and the
					// target heading may take a frame or two to paint.  Keep
					// re-resolving until it appears so the exact settle below runs
					// instead of leaving the estimate scroll uncorrected.
					for (let attempt = 0; attempt < 30; attempt++) {
						await new Promise<void>((resolve) =>
							window.requestAnimationFrame(() => resolve()),
						);
						targetHeading = s.positionSource.resolveHeadingEl(entry) ?? null;
						if (targetHeading) break;
					}
				}
			}

			if (targetHeading) {
				await this.settleScrollToHeading(targetHeading as HTMLElement);
				if (s.navigationGeneration !== gen) return;
				this.highlightHeading(targetHeading as HTMLElement);
			}

			this.spy.calculatePositions();
			// Mark positions as just-recalculated so the expand/collapse gate
			// in the spy waits for heading offsets to be measured instead of
			// firing immediately on line-based estimates.
			s.positionsStableSince = performance.now();
			// Record navigation time and scroll position so the spy defers
			// pickActiveIndex until the user scrolls significantly away from
			// the teleport target — the pill stays on the teleported-to entry.
			s.lastNavigationTime = performance.now();
			s.lastNavigationScrollTop = s.scrollContainer.scrollTop;
			// Set activeEntryIndex BEFORE applyVisibility: the re-render
			// destroys and recreates rows, then calls reapplyHighlight()
			// which reads activeEntryIndex to re-host the highlight pill.
			// Without this, the first click after load (activeEntryIndex=-1)
			// leaves the pill orphaned and the next spy tick highlights a
			// wrong heading based on stale estimates.
			s.activeEntryIndex = entryIndex;
			this.spy.updateHighlight(entryIndex);

			// Apply auto-expand for the clicked heading
			const mode = s.settings?.autoExpandMode ?? 'disabled';
			if (mode !== 'disabled') {
				s.activePathSet = s.computeActivePath(entryIndex);
				s.applyVisibility();
			}
		} finally {
			// Wait for the scroll position to stabilize after applyVisibility
			// may have triggered re-layout (lazy renders, height changes).
			// Without this the spy wakes up on an intermediate scrollTop,
			// momentarily highlights a wrong heading and toggles expand/collapse.
			await this.waitForScrollSettle();
			window.clearTimeout(s.navigationTimer);
			if (s.navigationGeneration === gen) {
				s.navigationTimer = window.setTimeout(() => {
					s.navigating = false;
					s.isJumping = false;
				}, 50);
			}
		}
	}

	/**
	 * Wait until the book's scrollTop has not changed for several
	 * consecutive frames.  After `applyVisibility()` re-renders rows the
	 * lazy content can still shift the layout for a frame or two; this
	 * prevents the spy from firing on an intermediate position.
	 */
	private waitForScrollSettle(): Promise<void> {
		const s = this.state;
		return new Promise<void>((resolve) => {
			let stableFrames = 0;
			let prev = s.scrollContainer.scrollTop;
			const STABLE_FRAMES = 4;
			const check = () => {
				const cur = s.scrollContainer.scrollTop;
				if (Math.abs(cur - prev) < 1) {
					stableFrames++;
					if (stableFrames >= STABLE_FRAMES) {
						resolve();
						return;
					}
				} else {
					stableFrames = 0;
					prev = cur;
				}
				window.requestAnimationFrame(check);
			};
			window.requestAnimationFrame(check);
		});
	}

	/**
	 * The heading rect read right after a section mounts is stale: async
	 * renders (images, code blocks) and re-mounting of neighbouring sections
	 * keep shifting the layout for a few frames. Re-measure and re-correct
	 * the scroll until the heading's on-screen position stabilizes.
	 */
	private async settleScrollToHeading(heading: HTMLElement): Promise<void> {
		const s = this.state;
		for (let attempt = 0; attempt < 30; attempt++) {
			const headingRect = heading.getBoundingClientRect();
			const containerRect = s.scrollContainer.getBoundingClientRect();
			const target =
				s.scrollContainer.scrollTop +
				(headingRect.top - containerRect.top) -
				20;
			if (Math.abs(s.scrollContainer.scrollTop - target) < 1) break;
			guardedScrollWrite(s.scrollContainer, () => {
				s.scrollContainer.scrollTo({
					top: Math.max(0, target),
					behavior: 'auto',
				});
			});
			await new Promise<void>((resolve) =>
				window.requestAnimationFrame(() => resolve()),
			);
		}
	}

	private highlightHeading(el: HTMLElement): void {
		el.addClass('book-heading-highlight');
		const handler = () => {
			el.removeClass('book-heading-highlight');
			el.removeEventListener('animationend', handler);
		};
		el.addEventListener('animationend', handler);
	}

	destroy(): void {
		window.clearTimeout(this.state.navigationTimer);
	}
}
