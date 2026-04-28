import { PlatformModule } from '../types';
import { registerXBackgroundHandlers } from './background';
import { appendXVideoFallback, isXStatusUrl } from './extractor';

export const xPlatform: PlatformModule = {
	id: 'x',
	matches: isXStatusUrl,
	registerBackgroundHandlers: registerXBackgroundHandlers,
	async afterExtract({ parsed, url }) {
		if (!parsed?.content) return parsed;
		return {
			...parsed,
			content: await appendXVideoFallback(parsed.content, url),
		};
	},
};
