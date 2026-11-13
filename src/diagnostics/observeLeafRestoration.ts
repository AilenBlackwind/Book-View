import { WorkspaceLeaf } from 'obsidian';
import type { StartupTrace } from './StartupTrace';

/** Temporary observer of the public API, without awaiting workspace readiness. */
export function observeLeafRestoration(trace: StartupTrace, name: (leaf: WorkspaceLeaf) => string): () => void {
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Deliberately capture the prototype method; invoke it with the original receiver below.
	const original = WorkspaceLeaf.prototype.setViewState;
	const wrapped: typeof original = function (this: WorkspaceLeaf, ...args: Parameters<typeof original>) {
		if (!trace.active) return original.apply(this, args);
		const end = trace.begin(`${name(this)} setViewState ${args[0].type}`, new Error('Caller').stack);
		try {
			return original.apply(this, args).then((value) => {
				end();
				return value;
			}, (error: unknown) => {
				end(error);
				throw error;
			});
		} catch (error) {
			end(error);
			throw error;
		}
	};
	WorkspaceLeaf.prototype.setViewState = wrapped;
	return () => {
		if (WorkspaceLeaf.prototype.setViewState === wrapped) WorkspaceLeaf.prototype.setViewState = original;
	};
}
