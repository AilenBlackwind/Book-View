import { describe, expect, it } from 'vitest';
import { StartupTrace } from '../src/diagnostics/StartupTrace';

function setup() {
	let ms = 1000;
	const trace = new StartupTrace({ startedAt: 'test', version: 'test', mode: 'startup', entries: [] }, () => ms);
	return { trace, advance: (amount: number) => { ms += amount; } };
}

describe('startup diagnostics', () => {
	it('shows unfinished restoration at checkpoints and includes its eventual duration', () => {
		const { trace, advance } = setup();
		const end = trace.begin('FileView.setState');
		advance(10000);
		trace.checkpoint('layoutReady=false');
		expect(trace.report.entries.at(-1)?.detail).toContain('FileView.setState: 10000ms pending');
		end();
		expect(trace.pending.size).toBe(0);
		expect(trace.report.entries.at(-1)?.detail).toBe('10000ms');
		end();
		expect(trace.report.entries).toHaveLength(3);
	});

	it('preserves successful results and throws the original rejection', async () => {
		const { trace } = setup();
		const value = {};
		expect(await trace.measure('open', () => Promise.resolve(value))).toBe(value);
		const error = new Error('failed restoration');
		await expect(trace.measure('open', () => Promise.reject(error))).rejects.toBe(error);
		expect(trace.pending.size).toBe(0);
		expect(trace.report.entries.at(-1)?.event).toContain('failed');
		expect(trace.report.entries.at(-1)?.detail).toContain('failed restoration');
	});

	it('records synchronous throws without leaving a false pending operation', async () => {
		const { trace } = setup();
		const error = new Error('sync failure');
		await expect(trace.measure('open', () => { throw error; })).rejects.toBe(error);
		expect(trace.pending.size).toBe(0);
	});

	it('bounds event storage and does not record after capture stops', () => {
		const { trace } = setup();
		for (let i = 0; i < 1000; i++) trace.record('layout change');
		expect(trace.report.entries).toHaveLength(250);
		trace.checkpoint('last checkpoint');
		expect(trace.report.entries.at(-1)?.detail).toContain('last checkpoint');
		trace.active = false;
		trace.begin('late open')();
		expect(trace.pending.size).toBe(0);
	});
});
