import { debugLog } from '../../utils/debug';
import { PlatformModule } from '../types';
import { registerFeishuBackgroundHandlers } from './background';
import { extractFeishuStructuredContent, isFeishuDocUrl } from './extractor';
import { processFeishuMarkdown } from './markdown';
import { saveFeishuToObsidian } from './save';

export const feishuPlatform: PlatformModule = {
	id: 'feishu',
	matches: isFeishuDocUrl,
	registerBackgroundHandlers: registerFeishuBackgroundHandlers,
	async extractStructuredContent({ document }) {
		const content = await extractFeishuStructuredContent(document).catch((error) => {
			debugLog('Feishu', 'Failed to extract structured content', {
				error: error instanceof Error ? error.message : String(error),
			});
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
	saveToObsidian(context) {
		return saveFeishuToObsidian(context);
	},
};
