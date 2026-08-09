/**
 * Ring-buffer debug logger for the absolute-positioning engine. Every method
 * is a no-op while DEBUG is off; hot-path call sites pass raw primitives so
 * the scroll paths never allocate debug strings when disabled.
 */
export class DebugLog {
	static readonly ENABLED = false;

	private static readonly MAX = 2000;

	/** Append a timestamped line to window.__bvLog (capped at MAX entries). */
	static log(
		msg: string,
		path?: string,
		a?: number | string,
		b?: number | string,
		c?: number | string,
	): void {
		if (!DebugLog.ENABLED) return;
		const w = window as unknown as { __bvLog?: string[] };
		const log = w.__bvLog ?? (w.__bvLog = []);
		let line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
		if (path) line += ` ${path.split('/').pop()}`;
		if (a !== undefined) line += ` ${a}`;
		if (b !== undefined) line += ` ${b}`;
		if (c !== undefined) line += ` ${c}`;
		log.push(line);
		if (log.length > DebugLog.MAX) log.splice(0, log.length - DebugLog.MAX);
	}
}
