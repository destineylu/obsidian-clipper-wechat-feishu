import { PlatformModule } from '../types';
import { registerXBackgroundHandlers } from './background';
import { appendXVideoFallback, hydrateXMediaBeforeExtract, isXStatusUrl } from './extractor';

export const xPlatform: PlatformModule = {
	id: 'x',
	matches: isXStatusUrl,
	registerBackgroundHandlers: registerXBackgroundHandlers,
	beforeDomNormalize({ document }) {
		return hydrateXMediaBeforeExtract(document);
	},
	async afterExtract({ parsed, url }) {
		if (!parsed?.content) return parsed;
		return {
			...parsed,
			content: await appendXVideoFallback(parsed.content, url, document),
		};
	},
};
