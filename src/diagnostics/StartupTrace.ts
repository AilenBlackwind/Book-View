export interface StartupEntry {
	ms: number;
	event: string;
	detail?: string;
}

export interface StartupReport {
	startedAt: string;
	version: string;
	mode: 'startup' | 'plugin reload';
	entries: StartupEntry[];
}

/** Bounded recorder; pending spans remain visible even if they never settle. */
export class StartupTrace {
	readonly pending = new Map<number, { name: string; ms: number }>();
	private nextId = 0;
	private dropped = 0;
	active = true;

	constructor(readonly report: StartupReport, private now: () => number) {}

	record(event: string, detail?: string, critical = false): void {
		if (!this.active) return;
		// Reserve space for checkpoints and completions if layout events flood
		// the buffer. Keep the last critical checkpoint even in that case.
		if (this.report.entries.length >= (critical ? 300 : 250)) {
			this.dropped++;
			if (!critical) return;
			this.report.entries.pop();
		}
		this.report.entries.push({ ms: Math.round(this.now()), event, detail: detail?.slice(0, 4000) });
	}

	begin(name: string, detail?: string): (error?: unknown) => void {
		if (!this.active) return () => {};
		const id = ++this.nextId;
		const ms = this.now();
		this.pending.set(id, { name, ms });
		this.record(`begin #${id} ${name}`, detail);
		return (error?: unknown) => {
			if (!this.pending.delete(id)) return;
			this.record(`${error === undefined ? 'end' : 'failed'} #${id} ${name}`,
				`${Math.round(this.now() - ms)}ms${error === undefined ? '' : `\n${errorText(error)}`}`, true);
		};
	}

	async measure<T>(name: string, action: () => Promise<T>, detail?: string): Promise<T> {
		const end = this.begin(name, detail);
		try {
			const value = await action();
			end();
			return value;
		} catch (error) {
			end(error);
			throw error;
		}
	}

	checkpoint(detail: string): void {
		const pending = [...this.pending].map(([id, span]) =>
			`#${id} ${span.name}: ${Math.round(this.now() - span.ms)}ms pending`);
		this.record('checkpoint', [detail, ...pending, `dropped events=${this.dropped}`].join('\n'), true);
	}
}

export function errorText(error: unknown): string {
	return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4000);
}
