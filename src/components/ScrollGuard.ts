import { DebugLog } from '../utils/debug';

export type ScrollWriteKind = 'scrollTop' | 'scrollTo' | 'scrollBy';

export interface ScrollGuardEvent {
	kind: ScrollWriteKind;
	/** New value for scrollTop writes, null for scrollTo/scrollBy. */
	value: number | null;
	blocked: boolean;
	/** Short caller label, captured only while DebugLog is enabled. */
	label: string;
}

const guards = new WeakMap<HTMLElement, ScrollGuard>();

function stackLabel(): string {
	return new Error().stack?.split('\n').slice(2, 5).join(' | ') ?? '';
}

/**
 * Scroll ownership guard for the book scroll container.
 *
 * Native scrolling (wheel, trackpad, touch, keyboard on a focused scroller)
 * never invokes the JS scrollTop accessor — the compositor updates the
 * internal slot directly. So EVERY call to the scrollTop setter or to
 * scrollTo/scrollBy on this element is programmatic JavaScript, and outside
 * a run() region it can only come from foreign code: third-party smooth-
 * scroll plugins animating the book's scrollTop per frame fight the
 * virtualizer's own anchor compensation and make gestures feel chaotic.
 *
 * The guard redefines the instance-level accessors (same mechanism as the
 * retired debug writer probe) and silently drops any write made outside
 * run(). Unlike an event shield this does not depend on plugin load order
 * or on how the foreign plugin is triggered — whatever drives it (wheel,
 * keyboard, its own rAF loop), moving the view still means writing scrollTop.
 *
 * Internal writers use the module-level guardedScrollWrite helper, which
 * resolves the guard for the element from a WeakMap, so call sites deep in
 * the layout/toc modules need no dependency threading. Elements without an
 * installed guard (the ToC panel, mocks in tests) execute writes directly.
 */
export class ScrollGuard {
	private depth = 0;
	private installed = false;

	/** Debug counter/event sink; assigned by the section manager. */
	onEvent: ((e: ScrollGuardEvent) => void) | null = null;

	constructor(private readonly el: HTMLElement) {}

	get active(): boolean {
		return this.depth > 0;
	}

	install(): void {
		if (this.installed) return;
		const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
		if (!desc?.set || !desc.get) return;
		// Guard accessors run with `this` = the element, not the guard; alias
		// the instance so the closures can reach the mutable depth state.
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- see above
		const self = this;
		Object.defineProperty(this.el, 'scrollTop', {
			configurable: true,
			// The native accessors MUST be invoked with the element as their
			// receiver (`.call(this)`), never extracted and bound to a plain
			// object — a native accessor called with a non-element receiver
			// throws "Illegal invocation", which would kill every scrollTop
			// read/write on the container.
			get: function (this: HTMLElement): number {
				return desc.get!.call(this) as number;
			},
			set: function (this: HTMLElement, v: number): void {
				if (self.depth > 0) {
					desc.set!.call(this, v);
					if (DebugLog.enabled) {
						self.onEvent?.({ kind: 'scrollTop', value: v, blocked: false, label: stackLabel() });
					}
				} else if (DebugLog.enabled) {
					self.onEvent?.({ kind: 'scrollTop', value: v, blocked: true, label: stackLabel() });
				}
			},
		});
		// Native scrollTo/scrollBy move the scroll position without going
		// through the scrollTop accessor, so they need their own wrappers.
		for (const name of ['scrollTo', 'scrollBy'] as const) {
			const original = (this.el as unknown as Record<string, unknown>)[name] as
				| ((...a: unknown[]) => void)
				| undefined;
			if (typeof original !== 'function') continue;
			const bound = original.bind(this.el);
			(this.el as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
				if (self.depth > 0) {
					bound(...args);
					if (DebugLog.enabled) {
						self.onEvent?.({ kind: name, value: null, blocked: false, label: stackLabel() });
					}
				} else if (DebugLog.enabled) {
					self.onEvent?.({ kind: name, value: null, blocked: true, label: stackLabel() });
				}
			};
		}
		guards.set(this.el, this);
		this.installed = true;
	}

	uninstall(): void {
		if (!this.installed) return;
		const el = this.el as unknown as Record<string, unknown>;
		delete el.scrollTop;
		delete el.scrollTo;
		delete el.scrollBy;
		guards.delete(this.el);
		this.installed = false;
		this.depth = 0;
	}

	/** Grant the callback permission to move the scroll position. */
	run<T>(fn: () => T): T {
		this.depth++;
		try {
			return fn();
		} finally {
			this.depth--;
		}
	}
}

/** Execute a scroll write on `el`, passing through the element's guard when
 *  one is installed. Elements without a guard (ToC panel, test mocks) run
 *  the write directly, so call sites stay dependency-free. */
export function guardedScrollWrite<T>(el: HTMLElement, fn: () => T): T {
	const guard = guards.get(el);
	return guard ? guard.run(fn) : fn();
}
