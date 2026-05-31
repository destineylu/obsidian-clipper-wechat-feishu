import browser from '../../utils/browser-polyfill';
import { getDomain } from '../../utils/string-utils';
import { PlatformModule } from '../types';
import { registerDouyinBackgroundHandlers } from './background';
import { extractDouyinStructuredContent, isDouyinAwemeUrl } from './extractor';

export const douyinPlatform: PlatformModule = {
	id: 'douyin',
	matches: isDouyinAwemeUrl,
	registerBackgroundHandlers: registerDouyinBackgroundHandlers,
	async extractStructuredContent({ document, url }) {
		const content = await extractDouyinStructuredContent(document, url, fetchDouyinHtml).catch((error) => {
			console.warn('Failed to extract Douyin structured content:', error);
			return null;
		});
		if (!content) return null;

		return {
			author: content.author,
			content: content.structuredHtml,
			description: content.description,
			image: content.image,
			published: content.published,
			site: '抖音',
			title: content.title,
			wordCount: content.wordCount,
			variables: {
				douyinAwemeId: content.awemeId,
				douyinType: content.type,
				douyinImages: content.images.join('\n'),
				douyinVideo: content.videoUrl,
				douyinDescription: content.description,
			},
		};
	},
	async extractReaderContent({ document, url }) {
		const startTime = performance.now();
		const content = await extractDouyinStructuredContent(document, url, fetchDouyinHtml).catch((error) => {
			console.warn('Reader', 'Failed to extract Douyin structured content:', error);
			return null;
		});
		if (!content) return null;

		return {
			content: content.structuredHtml,
			title: content.title,
			author: content.author,
			published: content.published,
			domain: getDomain(url),
			wordCount: content.wordCount,
			parseTime: Math.round(performance.now() - startTime),
			extractorType: 'douyin',
		};
	},
};

async function fetchDouyinHtml(url: string): Promise<string> {
	const response = await browser.runtime.sendMessage({
		action: 'fetchDouyinHtml',
		url,
	}) as { success?: boolean; html?: string; finalUrl?: string; error?: string };

	if (!response?.success || !response.html) {
		throw new Error(response?.error || 'Failed to fetch Douyin aweme');
	}

	return response.html;
}
