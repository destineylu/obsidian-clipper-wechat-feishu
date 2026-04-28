import { PlatformModule } from '../types';
import { registerFeishuBackgroundHandlers } from './background';
import { extractFeishuStructuredContent, isFeishuDocUrl } from './extractor';
import { processFeishuMarkdown } from './markdown';

export const feishuPlatform: PlatformModule = {
	id: 'feishu',
	matches: isFeishuDocUrl,
	registerBackgroundHandlers: registerFeishuBackgroundHandlers,
	async extractStructuredContent({ document }) {
		const content = await extractFeishuStructuredContent(document).catch((error) => {
			console.warn('Failed to extract Feishu structured content:', error);
			return null;
		});
		if (!content) return null;
		return {
			author: content.author,
			content: content.content,
			site: 'Feishu',
			title: content.title,
			wordCount: content.wordCount,
		};
	},
	afterMarkdown({ content, currentUrl }) {
		return processFeishuMarkdown(content, currentUrl);
	},
};
