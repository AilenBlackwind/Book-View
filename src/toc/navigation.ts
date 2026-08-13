import { TocState } from './state';
import { TocSpy } from './spy';
import { HEIGHT_PER_LINE } from '../components/AbsoluteSectionManager';

/** Click-navigation to a ToC entry: jump the book to the heading, settle the
 *  scroll once async renders stop shifting the layout, and flash a highlight
 *  on the target. */
export class TocNavigator {
	constructor(private state: TocState, private spy: TocSpy) {}

	async scrollToHeading(entryIndex: number): Promise<void> {
		const s = this.state;
		const entry = s.entries[entryIndex];
		if (!entry || !s.absoluteManager) return;

		s.navigating = true;
		s.isJumping = true;
		try {
			const sectionOffset = s.absoluteManager.getOffset(entry.file.path);
			const estimatedY = sectionOffset + entry.line * HEIGHT_PER_LINE;

			s.scrollContainer.scrollTo({ top: Math.max(0, estimatedY - 20), behavior: 'auto' });

			const placeholder = s.scrollContainer.querySelector(
				`.book-section-placeholder[data-path="${entry.file.path}"]`,
			);
			if (!(placeholder instanceof HTMLElement)) return;

			let targetHeading: Element | null = null;
			for (let attempt = 0; attempt < 30; attempt++) {
				const headings = placeholder.querySelectorAll('h1, h2, h3, h4, h5, h6');
				targetHeading = headings[entry.fileHeadingIndex] ?? null;
				if (targetHeading) break;
				await new Promise<void>((resolve) =>
					window.requestAnimationFrame(() => resolve()),
				);
			}

			if (targetHeading) {
				await this.settleScrollToHeading(targetHeading as HTMLElement);
				this.highlightHeading(targetHeading as HTMLElement);
			}

			this.spy.calculatePositions();
			this.spy.updateHighlight(entryIndex);

			// Apply auto-expand for the clicked heading
			const mode = s.settings?.autoExpandMode ?? 'disabled';
			if (mode !== 'disabled') {
				s.activePathSet = s.computeActivePath(entryIndex);
				s.applyVisibility();
			}
		} finally {
			window.clearTimeout(s.navigationTimer);
			s.navigationTimer = window.setTimeout(() => {
				s.navigating = false;
				s.isJumping = false;
			}, 200);
		}
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
			s.scrollContainer.scrollTo({
				top: Math.max(0, target),
				behavior: 'auto',
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
