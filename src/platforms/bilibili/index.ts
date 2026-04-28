import { getDomain } from '../../utils/string-utils';
import { PlatformModule } from '../types';
import { registerBilibiliBackgroundHandlers } from './background';
import { extractBilibiliStructuredContent, isBilibiliVideoUrl } from './extractor';
import { captureBilibiliReaderState, cleanupBilibiliReader, enhanceBilibiliReader } from './reader';

export const bilibiliPlatform: PlatformModule = {
	id: 'bilibili',
	matches: isBilibiliVideoUrl,
	registerBackgroundHandlers: registerBilibiliBackgroundHandlers,
	captureReaderState: captureBilibiliReaderState,
	enhanceReader: enhanceBilibiliReader,
	onReaderRestore: cleanupBilibiliReader,
	async extractStructuredContent({ document }) {
		const content = await extractBilibiliStructuredContent(document).catch((error) => {
			console.warn('Failed to extract Bilibili structured content:', error);
			return null;
		});
		if (!content) return null;
		return {
			author: content.author,
			content: content.structuredHtml,
			description: content.description,
			image: content.image,
			published: content.published,
			site: 'Bilibili',
			title: content.title,
			wordCount: content.wordCount,
			variables: {
				transcript: content.transcriptMarkdown,
				transcriptMarkdown: content.transcriptMarkdown,
				transcriptText: content.transcriptText,
				chapters: content.chaptersMarkdown,
				bvid: content.bvid,
				cid: String(content.cid),
				page: String(content.page),
			},
		};
	},
	async extractReaderContent({ document, url }) {
		const startTime = performance.now();
		const content = await extractBilibiliStructuredContent(document).catch((error) => {
			console.warn('Reader', 'Failed to extract Bilibili structured content:', error);
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
			extractorType: 'bilibili',
		};
	},
};
