import { DebugLog } from '../utils/debug';
import { guardedScrollWrite } from './ScrollGuard';

export interface WheelFlickConfig {
	enabled: boolean;
	/** Total scroll distance per notch, as a multiple of the native amount. */
	strength: number;
	/** Per-frame velocity decay (higher = longer glide). */
	friction: number;
	/** Block third-party wheel listeners (smooth-scroll plugins) from seeing
	 *  wheel events over the book container even when acceleration is off. */
	shield: boolean;
}

export type WheelFlickConfigGetter = () => WheelFlickConfig;

const COMBO_WINDOW_MS = 200;
const COMBO_STEP = 0.5;
const COMBO_MAX = 3;
const NOTCH_THRESHOLD_PX = 40;
const LINE_HEIGHT_PX = 33;
/** Idle time after the last notch before a gesture is considered finished
 *  and its intended-vs-actual travel is reported (debug probe). */
const GESTURE_REPORT_DELAY_MS = 300;

/**
 * Turns mouse wheel notches into smooth accelerated flicks inside the book
 * view scroll container.
 *
 * Two design rules keep it conflict-free:
 *
 * 1. One capture-phase interceptor on window, registered at plugin onload.
 *    It acts only on events targeted at a `.book-content-container`. There
 *    are two independent layers:
 *
 *    - Shield (cfg.shield): stopImmediatePropagation() for every vertical
 *      wheel over the container, regardless of the accelerator toggle, so
 *      third-party smooth-scroll plugins never see the event. No
 *      preventDefault while acceleration is off — native scrolling keeps its
 *      exact feel. If a foreign handler registered before ours already
 *      preventDefault-ed the event, the native-equivalent delta is applied
 *      manually under the ScrollGuard token.
 *    - Acceleration (cfg.enabled): preventDefault + the flick impulse.
 *
 *    The event shield is belt-and-suspenders: the ScrollGuard on the
 *    container already drops foreign scrollTop/scrollTo writes no matter who
 *    writes or in which order plugins loaded. Stopping propagation first
 *    merely avoids wasted work and prevents a foreign handler from
 *    cancelling the default action.
 *
 * 2. The animation loop never captures a baseline scrollTop. Every frame it
 *    reads the CURRENT scrollTop and adds velocity, so an external write
 *    (scroll anchoring compensation, TOC jump) is absorbed into the motion
 *    instead of being overwritten — the two writers compose additively. Its
 *    own write goes through guardedScrollWrite so the guard lets it pass.
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
	private cachedMaxScroll = 0;

	// Temporary gesture-accuracy probe (DebugLog-gated): accumulates the
	// intended travel of one wheel gesture (Σ deltaY × strength × combo) and,
	// after the glide settles, reports it against the actual displacement.
	// The difference quantifies the "imprecise short scroll" feel — anchor
	// compensations landing mid-glide shift the resting point away from the
	// intended travel.
	private gestStartTop = 0;
	private gestIntended = 0;
	private gestTracking = false;
	private gestReportTimer = 0;

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
		window.clearTimeout(this.gestReportTimer);
		this.container.removeEventListener('mousedown', this.kill, { capture: true });
		WheelAccelerator.instances.delete(this.container);
	}

	private handleWheel(evt: WheelEvent): void {
		const cfg = this.getConfig();
		// ctrl = zoom, shift = horizontal scroll: leave both native.
		if (evt.ctrlKey || evt.shiftKey) return;

		const dy = evt.deltaY;
		if (dy === 0) return;

		// Nested scrollables (embeds, code blocks…) keep native behavior.
		if (this.findScrollableTarget(evt.target) !== this.container) return;

		// Shield: claim every vertical wheel over the book container from other
		// listeners, BEFORE any delta classification or accelerator gating.
		// With acceleration off only propagation is stopped (no preventDefault),
		// so the browser's native scroll keeps its exact native feel while
		// third-party smooth-scroll plugins are locked out.
		if (cfg.shield) {
			evt.stopImmediatePropagation();
			// A foreign capture handler registered before ours may have run
			// first and cancelled the default action. With acceleration off,
			// apply the native-equivalent delta ourselves under the guard
			// token; otherwise the wheel would do nothing at all.
			if (!cfg.enabled && evt.defaultPrevented) {
				const px = evt.deltaMode === WheelEvent.DOM_DELTA_LINE ? dy * LINE_HEIGHT_PX : dy;
				guardedScrollWrite(this.container, () => {
					this.container.scrollTop += px;
				});
				return;
			}
		}

		// Trackpads and high-resolution wheels emit many small pixel deltas;
		// leave them native so two-finger scrolling keeps its native feel.
		const isNotch = evt.deltaMode === WheelEvent.DOM_DELTA_LINE || Math.abs(dy) >= NOTCH_THRESHOLD_PX;
		if (!isNotch || !cfg.enabled) return;

		// Edge chaining: at the boundary in the flick direction, let the event
		// propagate natively so parent scrollers can take over.
		const maxScroll = this.container.scrollHeight - this.container.clientHeight;
		this.cachedMaxScroll = maxScroll;
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

		if (!this.gestTracking) {
			this.gestTracking = true;
			this.gestStartTop = this.container.scrollTop;
			this.gestIntended = 0;
		}
		this.gestIntended += px * cfg.strength * this.combo;
		window.clearTimeout(this.gestReportTimer);
		this.gestReportTimer = window.setTimeout(() => this.reportGesture(), GESTURE_REPORT_DELAY_MS);

		this.startLoop();
	}

	private reportGesture(): void {
		this.gestTracking = false;
		if (!DebugLog.enabled) return;
		const actual = this.container.scrollTop - this.gestStartTop;
		DebugLog.log(
			'GESTURE',
			'',
			`intended=${Math.round(this.gestIntended)}`,
			`actual=${Math.round(actual)}`,
			`err=${Math.round(actual - this.gestIntended)}`,
		);
	}

	private findScrollableTarget(target: EventTarget | null): HTMLElement {
		let el = target instanceof Element ? target : null;
		while (el && el !== this.container) {
			if (el.instanceOf(HTMLElement)) {
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
		// Cache maxScroll across frames: reading scrollHeight flushes a dirty
		// layout, and a long flick would otherwise pay that forced recalc on
		// every frame. Refresh only when approaching the cached bottom bound or
		// when the cache is empty (content heights can change mid-glide).
		let maxScroll = this.cachedMaxScroll;
		if (maxScroll <= 0 || c.scrollTop >= maxScroll - LINE_HEIGHT_PX) {
			maxScroll = Math.max(0, c.scrollHeight - c.clientHeight);
			this.cachedMaxScroll = maxScroll;
		}
		const next = Math.min(Math.max(c.scrollTop + this.velocity, 0), maxScroll);
		guardedScrollWrite(c, () => {
			c.scrollTop = next;
		});
		const friction = this.getConfig().friction;
		this.velocity *= friction;
		const atEdge = (next <= 0 && this.velocity < 0) || (next >= maxScroll && this.velocity > 0);
		// Stop when the un-run remainder of the geometric series (v/(1-f))
		// drops under one pixel: everything past that is sub-pixel drift,
		// which the fractional scrollTop accumulation still applies frame by
		// frame, fading out smoothly. Cutting earlier threw away up to ~6px
		// per gesture (systematic undershoot), and landing the remainder in
		// one jump read as a hard terminal notch — this cutoff keeps both
		// accuracy and the smooth decay.
		if (atEdge || (this.velocity !== 0 && Math.abs(this.velocity) / (1 - friction) < 1)) {
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
