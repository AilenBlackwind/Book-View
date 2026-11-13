import { apiVersion, normalizePath } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type BookViewPlugin from '../main';
import { errorText, StartupTrace } from './StartupTrace';
import type { StartupReport } from './StartupTrace';
import { observeLeafRestoration } from './observeLeafRestoration';

const REPORT_LIMIT = 20;

/** Opt-in, local startup recording. Never awaited by workspace restoration. */
export class StartupDiagnostics extends StartupTrace {
	private history: StartupReport[] = [];
	private loaded: Promise<void>;
	private writes: Promise<void> = Promise.resolve();
	private timers: number[] = [];
	private interval = 0;
	private restoreLeafMethod: () => void = () => {};
	private leafIds = new WeakMap<WorkspaceLeaf, number>();
	private nextLeafId = 0;
	private path: string;
	private writeError = '';

	constructor(private plugin: BookViewPlugin, loadStarted: number) {
		super({
			startedAt: new Date(performance.timeOrigin).toISOString(),
			version: `Obsidian API ${apiVersion}; Book View ${plugin.manifest.version}`,
			mode: plugin.app.workspace.layoutReady ? 'plugin reload' : 'startup',
			entries: [],
		}, () => performance.now());
		this.path = normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/startup-diagnostics.json`);
		this.record('recorder started', `plugin onload began at +${Math.round(loadStarted)}ms`);
		this.loaded = this.readHistory();
		this.install();
	}

	private async readHistory(): Promise<void> {
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (!await adapter.exists(this.path)) return;
			const parsed: unknown = JSON.parse(await adapter.read(this.path));
			if (Array.isArray(parsed)) {
				this.history = parsed.filter((item: unknown): item is StartupReport => {
					if (!item || typeof item !== 'object') return false;
					const report = item as Partial<StartupReport>;
					return typeof report.startedAt === 'string' && Array.isArray(report.entries);
				}).slice(-(REPORT_LIMIT - 1));
			}
		} catch (error) {
			this.record('history read failed', errorText(error));
		}
	}

	leafName(leaf: WorkspaceLeaf): string {
		let id = this.leafIds.get(leaf);
		if (id === undefined) {
			id = ++this.nextLeafId;
			this.leafIds.set(leaf, id);
		}
		return `leaf#${id}`;
	}

	private snapshot(): string {
		const leaves: string[] = [];
		try {
			this.plugin.app.workspace.iterateAllLeaves((leaf) => {
				leaves.push(`${this.leafName(leaf)} ${leaf.getViewState().type} deferred=${leaf.isDeferred}`);
			});
		} catch (error) {
			leaves.push(`snapshot failed: ${errorText(error)}`);
		}
		return `layoutReady=${this.plugin.app.workspace.layoutReady}\n${leaves.slice(0, 40).join('\n')}`;
	}

	private install(): void {
		const plugin = this.plugin;
		this.restoreLeafMethod = observeLeafRestoration(this, (leaf) => this.leafName(leaf));
		plugin.register(() => this.stop('plugin unloaded'));
		plugin.registerEvent(plugin.app.workspace.on('layout-change', () => this.record('layout-change')));
		plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', (leaf) => {
			if (!this.active) return;
			this.record('active-leaf-change', leaf ? `${this.leafName(leaf)} ${leaf.getViewState().type}` : 'none');
		}));
		plugin.registerDomEvent(window, 'error', (event) => this.record('window error', errorText(event.error ?? event.message)));
		plugin.registerDomEvent(window, 'unhandledrejection', (event) => this.record('unhandled rejection', errorText(event.reason)));
		plugin.app.workspace.onLayoutReady(() => {
			if (!this.active) return;
			this.record('layout-ready', this.snapshot());
			void this.save();
		});
		let lastTick = performance.now();
		this.interval = window.setInterval(() => {
			const now = performance.now();
			if (now - lastTick > 1500) this.record('event loop gap', `${Math.round(now - lastTick)}ms visibility=${document.visibilityState}`);
			lastTick = now;
		}, 500);
		plugin.registerInterval(this.interval);
		for (const ms of [5000, 15000, 30000, 60000]) {
			this.timers.push(window.setTimeout(() => {
				this.checkpoint(this.snapshot());
				if (ms === 60000) this.stop('recording window ended');
				else void this.save();
			}, ms));
		}
	}

	/** Serialize writes and preserve prior launches rather than overwriting them. */
	private save(): Promise<void> {
		this.writes = this.writes.then(async () => {
			await this.loaded;
			await this.plugin.app.vault.adapter.write(this.path, JSON.stringify([...this.history, this.report].slice(-REPORT_LIMIT), null, 2));
			this.writeError = '';
		}).catch((error: unknown) => {
			this.writeError = errorText(error);
			console.warn('Book View: startup report could not be saved', error);
		});
		return this.writes;
	}

	stop(reason: string): void {
		if (!this.active) return;
		this.checkpoint(this.snapshot());
		this.record(reason, undefined, true);
		this.active = false;
		for (const timer of this.timers) window.clearTimeout(timer);
		window.clearInterval(this.interval);
		this.restoreLeafMethod();
		void this.save();
	}

	async copyReports(): Promise<void> {
		await this.save();
		const reports = [...this.history, this.report].slice(-REPORT_LIMIT);
		await navigator.clipboard.writeText(JSON.stringify({
			note: 'Times are milliseconds since page start. Capture begins after Book View settings load and lasts 60 seconds. Caller stacks may identify plugins; pending operations and event loop gaps are clues, not proof of blame.',
			writeError: this.writeError || undefined,
			reports,
		}, null, 2));
	}
}
