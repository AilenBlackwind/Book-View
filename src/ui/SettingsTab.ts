import { App, PluginSettingTab, Setting } from 'obsidian';
import type BookViewPlugin from '../main';

export class BookViewSettingTab extends PluginSettingTab {
	plugin: BookViewPlugin;

	constructor(app: App, plugin: BookViewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Table of contents width')
			.setDesc('Width of the toc panel in pixels.')
			.addSlider((slider) =>
				slider
					.setLimits(150, 500, 10)
					.setValue(this.plugin.settings.tocWidth)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
						this.plugin.settings.tocWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show file names in toc')
			.setDesc('Display file names as section headers in the table of contents.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tocShowFileNames)
					.onChange(async (value: boolean) => {
						this.plugin.settings.tocShowFileNames = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show nesting guides in toc')
			.setDesc('Display vertical guide lines from headings to show nesting depth.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tocGuides)
					.onChange(async (value: boolean) => {
						this.plugin.settings.tocGuides = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Render Markdown in toc')
			.setDesc('Render bold, italic, code and other inline Markdown in headings instead of showing raw syntax.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tocRenderMarkdown)
					.onChange(async (value: boolean) => {
						this.plugin.settings.tocRenderMarkdown = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Lazy load margin')
			.setDesc('How many pixels above and below the viewport to pre-load sections. Increase for slower devices, decrease for faster ones.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 3000, 50)
					.setValue(this.plugin.settings.loadMargin)
					.setDynamicTooltip()
					.onChange(async (value: number) => {
						this.plugin.settings.loadMargin = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
