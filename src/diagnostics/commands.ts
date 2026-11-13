import { Notice } from 'obsidian';
import type BookViewPlugin from '../main';

export function registerStartupDiagnosticCommands(plugin: BookViewPlugin): void {
	plugin.addCommand({
		id: 'copy-startup-diagnostics',
		name: 'Copy startup reports',
		callback: async () => {
			if (!plugin.startupDiagnostics) {
				new Notice('Enable startup diagnostics in plugin settings, then restart Obsidian.');
				return;
			}
			try {
				await plugin.startupDiagnostics.copyReports();
				new Notice('Startup reports copied.');
			} catch (error) {
				console.warn('Book View: could not copy startup reports', error);
				new Notice('Could not copy startup reports.');
			}
		},
	});
}
