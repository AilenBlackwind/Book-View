/**
 * Ring-buffer debug logger for the absolute-positioning engine. Off by
 * default; enable it at runtime with `DebugLog.setEnabled(true)` (the plugin
 * exposes a "Toggle debug logging" command). Every method is a no-op while
 * disabled and hot-path call sites pass raw primitives so the scroll paths
 * never allocate debug strings when off.
 */
export class DebugLog {
	private static _enabled = false;

	private static readonly MAX = 2000;

	/** Subscribers notified on every enable/disable flip (used to start/stop
	 *  the global frame probe). */
	private static listeners: ((enabled: boolean) => void)[] = [];

	static get enabled(): boolean {
		return DebugLog._enabled;
	}

	/** Turn logging on or off. Enabling clears the ring buffer first so the
	 *  log always starts fresh at the enable moment. Returns the new state. */
	static setEnabled(v: boolean): boolean {
		if (DebugLog._enabled === v) return DebugLog._enabled;
		DebugLog._enabled = v;
		if (v) {
			const w = window as unknown as { __bvLog?: string[] };
			w.__bvLog = [];
			DebugLog.log('DEBUG', 'enabled');
		}
		const listeners = DebugLog.listeners;
		DebugLog.listeners = [];
		for (const listener of listeners) listener(v);
		return DebugLog._enabled;
	}

	/** Flip the current state; returns the new one. */
	static toggle(): boolean {
		return DebugLog.setEnabled(!DebugLog._enabled);
	}

	static isEnabled(): boolean {
		return DebugLog._enabled;
	}

	/** Subscribe to enable/disable changes. Returns an unsubscribe function. */
	static onChange(listener: (enabled: boolean) => void): () => void {
		DebugLog.listeners.push(listener);
		return () => {
			const i = DebugLog.listeners.indexOf(listener);
			if (i >= 0) DebugLog.listeners.splice(i, 1);
		};
	}

	/** Drop all buffered entries. */
	static clear(): void {
		const w = window as unknown as { __bvLog?: string[] };
		if (w.__bvLog) w.__bvLog.length = 0;
	}

	/** Append a timestamped line to window.__bvLog (capped at MAX entries). */
	static log(
		msg: string,
		path?: string,
		a?: number | string,
		b?: number | string,
		c?: number | string,
		d?: number | string,
	): void {
		if (!DebugLog._enabled) return;
		const w = window as unknown as { __bvLog?: string[] };
		const log = w.__bvLog ?? (w.__bvLog = []);
		let line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
		if (path) line += ` ${path.split('/').pop()}`;
		if (a !== undefined) line += ` ${a}`;
		if (b !== undefined) line += ` ${b}`;
		if (c !== undefined) line += ` ${c}`;
		if (d !== undefined) line += ` ${d}`;
		log.push(line);
		if (log.length > DebugLog.MAX) log.splice(0, log.length - DebugLog.MAX);
	}
}
