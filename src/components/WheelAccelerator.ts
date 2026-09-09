import { DebugLog } from '../utils/debug';
import { guardedLastWriteValue, guardedScrollWrite } from './ScrollGuard';

export interface WheelFlickConfig {
	enabled: boolean;
	/** Total scroll distance per notch, as a multiple of the native amount. */
	strength: number;
	/** Per-frame velocity decay (higher = longer glide). */
	friction: number;
	/** Disable combo stacking: every notch travels exactly strength × its
	 *  native delta, independent of timing. For precise short scrolls. */
	precision: boolean;
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
 * 2. The animation loop never reads the container's scrollTop mid-glide. A
 *    live read would force a synchronous style recalc of whatever is dirty in
 *    that frame (a section mount, a ToC mutation, or a third-party tick like
 *    obsidian-git's periodic rel-time refresh), turning occasional dirt into
 *    a full reflow on every colliding frame. The glide position is instead a
 *    local `pos`, re-seeded from the DOM once per wheel notch, that absorbs
 *    external writes (anchor compensation, TOC jump) via the ScrollGuard's
 *    recorded write value — the two writers compose additively without any
 *    DOM read. Its own write goes through guardedScrollWrite so the guard
 *    lets it pass.
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

	// Readless glide position: the local authoritative scrollTop during a
	// flick, seeded from the DOM once per notch in handleWheel and advanced by
	// velocity in step. External writes land in pos via the guard's recorded
	// value, so step never reads the DOM (a read would force a style recalc of
	// whatever is dirty in that frame).
	private pos = 0;
	private lastSeenWrite = 0;

	// Uniform-coast tail (see stopAndLogCadence/step): once the per-frame
	// velocity drops below one pixel the geometric decay keeps emitting
	// fractional scrollTop steps, but the compositor rasterizes at integer
	// device pixels, so the visible motion is a series of 1px ticks whose
	// pauses grow as the decay slows — the "grainy glide tail" complaint.
	// Below 1px/frame the remaining travel (v/(1-f)) is instead replayed as
	// whole-pixel steps at a constant 1px/frame cadence, then a clean stop.
	/** Remaining whole-pixel steps of the coast tail; 0 = not coasting. Signed
	 *  to preserve direction (the impulse only ever feeds one direction). */
	private coast = 0;

	// Temporary cadence probe (DebugLog-gated): logs an interval when the
	// time between two consecutive step frames exceeds a threshold, to
	// discriminate "grainy glide" causes (Hypothesis B in IDEAS.md): if step
	// intervals stay ~16.6ms even during load-heavy passages, the grain is the
	// sub-pixel quantisation tail (Hypothesis A); if intervals periodically
	// jump to 33/50ms, the main thread is losing frames and the glide timing
	// itself is broken.
	private lastStepAt = 0;
	private stepProbeLongFrames = 0;

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
		const c = this.container;
		const maxScroll = c.scrollHeight - c.clientHeight;
		this.cachedMaxScroll = maxScroll;
		// One live read per wheel notch (event frequency, not frame frequency)
		// re-syncs the readless glide position with whatever state the DOM or a
		// foreign writer left since the last notch.
		const liveTop = c.scrollTop;
		this.pos = liveTop;
		this.lastSeenWrite = guardedLastWriteValue(c) ?? liveTop;
		const atTop = liveTop <= 0;
		const atBottom = liveTop >= maxScroll - 1;
		if ((dy < 0 && atTop && this.velocity <= 0) || (dy > 0 && atBottom && this.velocity >= 0)) return;

		evt.preventDefault();
		evt.stopImmediatePropagation();

		const now = Date.now();
		if (cfg.precision) {
			// Precision mode: no combo stacking — a notch always travels
			// exactly px × strength, whatever happened in the last 200ms.
			this.combo = 1;
		} else {
			this.combo = now - this.lastNotchAt < COMBO_WINDOW_MS ? Math.min(this.combo + COMBO_STEP, COMBO_MAX) : 1;
		}
		this.lastNotchAt = now;

		const px = evt.deltaMode === WheelEvent.DOM_DELTA_LINE ? dy * LINE_HEIGHT_PX : dy;

		// A notch in the opposite direction kills the current flick instantly.
		// The stacked combo resets with it: without this, a small "scroll back
		// a bit" notch right after two fast forward notches would travel at
		// combo 2.5× and overshoot wildly. During a uniform-coast tail the
		// velocity is held at 0, so the direction is read from the coast count.
		const movingDir = this.coast !== 0 ? Math.sign(this.coast) : Math.sign(this.velocity);
		if (movingDir !== 0 && Math.sign(px) !== movingDir) {
			this.velocity = 0;
			this.combo = 1;
		}
		// A new notch always resumes the full impulse — cancel any in-flight
		// uniform-coast tail so the fresh velocity drives the glide.
		this.coast = 0;

		// The impulse is sized so total flick travel equals px * strength *
		// combo: the sum of the geometric velocity series is impulse / (1 - friction).
		this.velocity += px * cfg.strength * this.combo * (1 - cfg.friction);

		if (!this.gestTracking) {
			this.gestTracking = true;
			this.gestStartTop = this.pos;
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
		// Absorb any programmatic scroll write made since the last step (anchor
		// compensation, TOC jump) from the guard's record — in memory, never a
		// DOM read, which would force a style recalc of whatever is dirty.
		const ext = guardedLastWriteValue(c);
		if (ext !== null && ext !== this.lastSeenWrite) {
			this.pos = ext;
			this.lastSeenWrite = ext;
		}
		// Cache maxScroll across frames: reading scrollHeight flushes a dirty
		// layout, and a long flick would otherwise pay that forced recalc on
		// every frame. Refresh only when approaching the cached bottom bound or
		// when the cache is empty (content heights can change mid-glide).
		let maxScroll = this.cachedMaxScroll;
		if (maxScroll <= 0 || this.pos >= maxScroll - LINE_HEIGHT_PX) {
			maxScroll = Math.max(0, c.scrollHeight - c.clientHeight);
			this.cachedMaxScroll = maxScroll;
		}

		// Uniform-coast tail: below 1px/frame the geometric decay keeps summing
		// sub-pixel steps that the compositor snaps to integer device pixels,
		// so the visible motion is clusters of frozen frames + a 1px tick with
		// ever-growing pauses — the "grainy when slowing down" feel. Once the
		// per-frame speed drops under a pixel, replay the remaining travel
		// (velocity/(1-f)) as whole-pixel steps at a constant 1px/frame cadence
		// and end with a clean stop: same distance, no cluster-pause pattern.
		if (this.coast !== 0) {
			const dir = this.coast > 0 ? 1 : -1;
			let next = this.pos + dir;
			if (next < 0) {
				next = 0;
			} else if (next > maxScroll) {
				next = maxScroll;
			}
			guardedScrollWrite(c, () => {
				c.scrollTop = next;
			});
			this.pos = next;
			this.lastSeenWrite = next;
			this.coast -= dir;
			// Cadence probe (see GESTURE comment): also valid during the coast.
			if (DebugLog.enabled && next > 0 && next < maxScroll) {
				const now = performance.now();
				if (this.lastStepAt !== 0 && now - this.lastStepAt > 30) {
					this.stepProbeLongFrames++;
				}
				this.lastStepAt = now;
			}
			if (this.coast === 0 || next <= 0 || next >= maxScroll) {
				this.stopAndLogCadence();
				return;
			}
			this.rafId = window.requestAnimationFrame(this.step);
			return;
		}

		const next = Math.min(Math.max(this.pos + this.velocity, 0), maxScroll);
		guardedScrollWrite(c, () => {
			c.scrollTop = next;
		});
		this.pos = next;
		this.lastSeenWrite = next;
		const friction = this.getConfig().friction;
		this.velocity *= friction;
		const atEdge = (next <= 0 && this.velocity < 0) || (next >= maxScroll && this.velocity > 0);
		// Cadence probe: a gap over 30ms (≥2 dropped frames at 60Hz, or a
		// panel that drops to 30Hz regardless of load) means the glide timing
		// itself is affected — not the quantisation tail. Log the worst gap per
		// gesture so the copy-debug-log command can tell A (sub-pixel, timing
		// clean) from B (main-thread frame drops) apart.
		if (DebugLog.enabled && !atEdge && this.velocity !== 0) {
			const now = performance.now();
			if (this.lastStepAt !== 0 && now - this.lastStepAt > 30) {
				this.stepProbeLongFrames++;
			}
			this.lastStepAt = now;
		}
		// Switch to the uniform-coast tail once the per-frame speed drops under
		// one pixel (see the coast branch above). Rounding the remaining
		// geometric travel (v/(1-f)) to whole pixels preserves the path.
		if (!atEdge && this.velocity !== 0 && Math.abs(this.velocity) < 1) {
			this.coast = Math.round(this.velocity / (1 - friction));
			this.velocity = 0;
			if (this.coast === 0) {
				this.stopAndLogCadence();
				return;
			}
			this.rafId = window.requestAnimationFrame(this.step);
			return;
		}
		// Stop when the un-run remainder of the geometric series (v/(1-f))
		// drops under one pixel (reached when friction*frames already got us
		// here at |v| >= 1, e.g. the 1/framerate upper bound of the decay).
		if (atEdge || (this.velocity !== 0 && Math.abs(this.velocity) / (1 - friction) < 1)) {
			this.stopAndLogCadence();
			return;
		}
		this.rafId = window.requestAnimationFrame(this.step);
	};

	/** End of a gesture: reset the velocity and report the cadence probe if any
	 *  long step gaps were observed (DebugLog-gated, safe no-op otherwise). */
	private stopAndLogCadence(): void {
		this.velocity = 0;
		this.coast = 0;
		if (DebugLog.enabled && this.stepProbeLongFrames > 0) {
			DebugLog.log(
				'GLIDE',
				'',
				`longFrameGaps=${this.stepProbeLongFrames}`,
			);
		}
		this.stepProbeLongFrames = 0;
		this.lastStepAt = 0;
	}

	private kill = (): void => {
		this.velocity = 0;
		this.coast = 0;
		this.combo = 1;
		this.lastStepAt = 0;
		this.stepProbeLongFrames = 0;
	};
}
