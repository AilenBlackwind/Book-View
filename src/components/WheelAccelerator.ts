export interface WheelFlickConfig {
	enabled: boolean;
	/** Total scroll distance per notch, as a multiple of the native amount. */
	strength: number;
	/** Per-frame velocity decay (higher = longer glide). */
	friction: number;
}

export type WheelFlickConfigGetter = () => WheelFlickConfig;

const COMBO_WINDOW_MS = 200;
const COMBO_STEP = 0.5;
const COMBO_MAX = 3;
const NOTCH_THRESHOLD_PX = 40;
const LINE_HEIGHT_PX = 33;
const STOP_VELOCITY = 0.5;

/**
 * Turns mouse wheel notches into smooth accelerated flicks inside the book
 * view scroll container.
 *
 * Two design rules keep it conflict-free:
 *
 * 1. One capture-phase interceptor on window, registered at plugin onload.
 *    It only acts on events targeted at a `.book-content-container` that has
 *    an active accelerator, and there calls preventDefault() +
 *    stopImmediatePropagation(). This neutralizes bubble-phase listeners and
 *    any capture listeners registered after us (i.e. typical wheel/smooth-
 *    scroll plugins) WITHOUT affecting anything outside the book view.
 *
 * 2. The animation loop never captures a baseline scrollTop. Every frame it
 *    reads the CURRENT scrollTop and adds velocity, so an external write
 *    (scroll anchoring compensation, TOC jump) is absorbed into the motion
 *    instead of being overwritten — the two writers compose additively.
 */
export class WheelAccelerator {
	private static instances = new Map<HTMLElement, WheelAccelerator>();

	/** Must be registered once, as early as possible in plugin onload. */
	static dispatchWheel(evt: WheelEvent): void {
		const target = evt.target;
		if (!(target instanceof Element)) return;
		const container = target.closest('.book-content-container');
		if (!(container instanceof HTMLElement)) return;
		WheelAccelerator.instances.get(container)?.handleWheel(evt);
	}

	private velocity = 0;
	private combo = 1;
	private lastNotchAt = 0;
	private rafId = 0;
	private destroyed = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly getConfig: WheelFlickConfigGetter,
	) {
		WheelAccelerator.instances.set(container, this);
		this.container.addEventListener('mousedown', this.kill, { capture: true });
	}

	destroy(): void {
		this.destroyed = true;
		if (this.rafId !== 0) {
			window.cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
		this.container.removeEventListener('mousedown', this.kill, { capture: true });
		WheelAccelerator.instances.delete(this.container);
	}

	private handleWheel(evt: WheelEvent): void {
		const cfg = this.getConfig();
		if (!cfg.enabled) return;
		// ctrl = zoom, shift = horizontal scroll: leave both native.
		if (evt.ctrlKey || evt.shiftKey) return;

		const dy = evt.deltaY;
		if (dy === 0) return;

		// Trackpads and high-resolution wheels emit many small pixel deltas;
		// leave them native so two-finger scrolling keeps its native feel.
		const isNotch = evt.deltaMode === WheelEvent.DOM_DELTA_LINE || Math.abs(dy) >= NOTCH_THRESHOLD_PX;
		if (!isNotch) return;

		// Nested scrollables (embeds, code blocks…) keep native behavior.
		if (this.findScrollableTarget(evt.target) !== this.container) return;

		// Edge chaining: at the boundary in the flick direction, let the event
		// propagate natively so parent scrollers can take over.
		const maxScroll = this.container.scrollHeight - this.container.clientHeight;
		const atTop = this.container.scrollTop <= 0;
		const atBottom = this.container.scrollTop >= maxScroll - 1;
		if ((dy < 0 && atTop && this.velocity <= 0) || (dy > 0 && atBottom && this.velocity >= 0)) return;

		evt.preventDefault();
		evt.stopImmediatePropagation();

		const now = Date.now();
		this.combo = now - this.lastNotchAt < COMBO_WINDOW_MS ? Math.min(this.combo + COMBO_STEP, COMBO_MAX) : 1;
		this.lastNotchAt = now;

		const px = evt.deltaMode === WheelEvent.DOM_DELTA_LINE ? dy * LINE_HEIGHT_PX : dy;

		// A notch in the opposite direction kills the current flick instantly.
		if (this.velocity !== 0 && Math.sign(px) !== Math.sign(this.velocity)) {
			this.velocity = 0;
		}

		// The impulse is sized so total flick travel equals px * strength *
		// combo: the sum of the geometric velocity series is impulse / (1 - friction).
		this.velocity += px * cfg.strength * this.combo * (1 - cfg.friction);

		this.startLoop();
	}

	private findScrollableTarget(target: EventTarget | null): HTMLElement {
		let el = target instanceof Element ? target : null;
		while (el && el !== this.container) {
			if (el instanceof HTMLElement) {
				const style = getComputedStyle(el);
				if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
					return el;
				}
			}
			el = el.parentElement;
		}
		return this.container;
	}

	private startLoop(): void {
		if (this.rafId !== 0 || this.destroyed) return;
		this.rafId = window.requestAnimationFrame(this.step);
	}

	private step = (): void => {
		this.rafId = 0;
		if (this.destroyed) return;
		const c = this.container;
		const maxScroll = Math.max(0, c.scrollHeight - c.clientHeight);
		const next = Math.min(Math.max(c.scrollTop + this.velocity, 0), maxScroll);
		c.scrollTop = next;
		this.velocity *= this.getConfig().friction;
		const atEdge = (next <= 0 && this.velocity < 0) || (next >= maxScroll && this.velocity > 0);
		if (Math.abs(this.velocity) < STOP_VELOCITY || atEdge) {
			this.velocity = 0;
			return;
		}
		this.rafId = window.requestAnimationFrame(this.step);
	};

	private kill = (): void => {
		this.velocity = 0;
		this.combo = 1;
	};
}
