import browser from '../../utils/browser-polyfill';
import { getDomain } from '../../utils/string-utils';
import { PlatformModule } from '../types';
import { registerXiaohongshuBackgroundHandlers } from './background';
import { extractXiaohongshuStructuredContent, isXiaohongshuNoteUrl } from './extractor';

export const xiaohongshuPlatform: PlatformModule = {
	id: 'xiaohongshu',
	matches: isXiaohongshuNoteUrl,
	registerBackgroundHandlers: registerXiaohongshuBackgroundHandlers,
	async extractStructuredContent({ document, url }) {
		const content = await extractXiaohongshuStructuredContent(document, url, fetchXiaohongshuHtml).catch((error) => {
			console.warn('Failed to extract Xiaohongshu structured content:', error);
			return null;
		});
		if (!content) return null;

		return {
			author: content.author,
			content: content.structuredHtml,
			description: content.description,
			image: content.image,
			published: content.published,
			site: '小红书',
			title: content.title,
			wordCount: content.wordCount,
			variables: {
				xiaohongshuNoteId: content.noteId,
				xiaohongshuType: content.type,
				xiaohongshuTags: content.tags.join(', '),
				xiaohongshuImages: content.images.join('\n'),
				xiaohongshuVideo: content.videoUrl,
				xiaohongshuDescription: content.description,
			},
		};
	},
	async extractReaderContent({ document, url }) {
		const startTime = performance.now();
		const content = await extractXiaohongshuStructuredContent(document, url, fetchXiaohongshuHtml).catch((error) => {
			console.warn('Reader', 'Failed to extract Xiaohongshu structured content:', error);
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
			extractorType: 'xiaohongshu',
		};
	},
};

async function fetchXiaohongshuHtml(url: string): Promise<string> {
	const response = await browser.runtime.sendMessage({
		action: 'fetchXiaohongshuHtml',
		url,
	}) as { success?: boolean; html?: string; finalUrl?: string; error?: string };

	if (!response?.success || !response.html) {
		throw new Error(response?.error || 'Failed to fetch Xiaohongshu note');
	}

	return response.html;
}
