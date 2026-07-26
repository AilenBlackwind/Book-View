export interface BookViewSettings {
	tocWidth: number;
	tocShowFileNames: boolean;
	tocGuides: boolean;
	tocRenderMarkdown: boolean;
	loadMargin: number;
	absolutePositioning: boolean;
}

export const DEFAULT_SETTINGS: BookViewSettings = {
	tocWidth: 260,
	tocShowFileNames: true,
	tocGuides: true,
	tocRenderMarkdown: true,
	loadMargin: 800,
	absolutePositioning: false,
};
