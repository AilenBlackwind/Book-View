export interface BookViewSettings {
	tocWidth: number;
	tocShowFileNames: boolean;
	tocGuides: boolean;
	tocRenderMarkdown: boolean;
	loadMargin: number;
	absolutePositioning: boolean;
	wheelFlickEnabled: boolean;
	wheelFlickStrength: number;
	wheelFlickFriction: number;
}

export const DEFAULT_SETTINGS: BookViewSettings = {
	tocWidth: 260,
	tocShowFileNames: true,
	tocGuides: true,
	tocRenderMarkdown: true,
	loadMargin: 800,
	absolutePositioning: false,
	wheelFlickEnabled: true,
	wheelFlickStrength: 2,
	wheelFlickFriction: 0.92,
};
