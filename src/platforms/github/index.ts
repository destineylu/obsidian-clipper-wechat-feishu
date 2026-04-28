import { PlatformModule } from '../types';
import { loadPlatformSettings } from '../settings';
import {
	applyGitHubReadmeFallback,
	inlineGitHubReadmeImages,
	isGitHubMarkdownUrl,
	normalizeGitHubReadmeImages,
} from './extractor';

export const githubPlatform: PlatformModule = {
	id: 'github',
	matches: isGitHubMarkdownUrl,
	beforeDomNormalize({ document, url }) {
		normalizeGitHubReadmeImages(document, url);
	},
	async afterExtract({ document, parsed, url }) {
		const nextParsed = applyGitHubReadmeFallback(document, parsed, url);
		const settings = await loadPlatformSettings();
		if (!settings.github.inlineReadmeImages || !nextParsed.content) return nextParsed;
		return {
			...nextParsed,
			content: await inlineGitHubReadmeImages(nextParsed.content, url, {
				maxImageBytes: settings.github.maxInlineImageBytes,
				maxTotalBytes: settings.github.maxInlineTotalBytes,
			}),
		};
	},
};
