import { setIcon } from 'obsidian';

export interface FindBarCallbacks {
	onQuery(query: string): void;
	onPrev(): void;
	onNext(): void;
	onToggleFindAll(): void;
	onClose(): void;
}

const DEBOUNCE_MS = 150;

/**
 * Find bar shown at the top of the book view (native Obsidian find/replace
 * bar look): input, match counter, previous/next chevrons, a "find all"
 * toggle and a close button. Pure DOM — the search itself runs in BookView
 * through the BookSearcher.
 */
export class FindBar {
	readonly el: HTMLElement;
	private input: HTMLInputElement;
	private countEl: HTMLElement;
	private findAllBtn: HTMLElement;
	private debounceTimer = 0;

	constructor(private cb: FindBarCallbacks) {
		this.el = createDiv({ cls: 'book-find-bar' });

		this.input = this.el.createEl('input', {
			cls: 'book-find-input',
			attr: { type: 'text', placeholder: 'Find in book…', autofocus: 'true', spellcheck: 'false' },
		});
		this.countEl = this.el.createDiv({ cls: 'book-find-count', text: '0 / 0' });

		const prevBtn = this.el.createEl('button', { cls: 'book-find-btn', attr: { 'aria-label': 'Previous match' } });
		setIcon(prevBtn, 'chevron-up');
		prevBtn.addEventListener('click', () => this.cb.onPrev());

		const nextBtn = this.el.createEl('button', { cls: 'book-find-btn', attr: { 'aria-label': 'Next match' } });
		setIcon(nextBtn, 'chevron-down');
		nextBtn.addEventListener('click', () => this.cb.onNext());

		this.findAllBtn = this.el.createEl('button', { cls: 'book-find-all', text: 'Find all' });
		this.findAllBtn.addEventListener('click', () => this.cb.onToggleFindAll());

		const closeBtn = this.el.createEl('button', { cls: 'book-find-btn', attr: { 'aria-label': 'Close' } });
		setIcon(closeBtn, 'x');
		closeBtn.addEventListener('click', () => this.cb.onClose());

		this.input.addEventListener('input', () => {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = window.setTimeout(() => this.cb.onQuery(this.input.value), DEBOUNCE_MS);
		});
		this.input.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				if (evt.shiftKey) this.cb.onPrev();
				else this.cb.onNext();
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				this.cb.onClose();
			}
		});
	}

	show(): void {
		this.el.addClass('is-open');
		this.input.focus();
		this.input.select();
	}

	hide(): void {
		this.el.removeClass('is-open');
	}

	getQuery(): string {
		return this.input.value;
	}

	setCount(current: number, total: number): void {
		this.countEl.setText(`${current} / ${total}`);
	}

	setFindAllActive(active: boolean): void {
		this.findAllBtn.toggleClass('is-active', active);
	}

	destroy(): void {
		window.clearTimeout(this.debounceTimer);
		this.el.detach();
	}
}
