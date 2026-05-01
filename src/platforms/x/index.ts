import { PlatformModule } from '../types';
import { registerXBackgroundHandlers } from './background';
import {
	appendXVideoFallback,
	buildXMarkdownWithMedia,
	extractXStructuredContent,
	hydrateXMediaBeforeExtract,
	isXStatusUrl,
} from './extractor';

export const xPlatform: PlatformModule = {
	id: 'x',
	matches: isXStatusUrl,
	registerBackgroundHandlers: registerXBackgroundHandlers,
	beforeDomNormalize({ document }) {
		return hydrateXMediaBeforeExtract(document);
	},
	extractStructuredContent({ document, url }) {
		return extractXStructuredContent(document, url);
	},
	async afterExtract({ document, parsed, url }) {
		if (!parsed?.content) return parsed;
		return {
			...parsed,
			content: await appendXVideoFallback(parsed.content, url, document),
		};
	},
	afterMarkdown({ content, currentUrl }) {
		return buildXMarkdownWithMedia(content, currentUrl);
	},
};
