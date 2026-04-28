import { bilibiliPlatform } from './bilibili';
import { feishuPlatform } from './feishu';
import { githubPlatform } from './github';
import { wechatPlatform } from './wechat';
import { xPlatform } from './x';
import {
	PlatformBackgroundContext,
	PlatformBackgroundHandler,
	PlatformContentContext,
	PlatformExtractContext,
	PlatformMarkdownContext,
	PlatformMarkdownResult,
	PlatformModule,
	PlatformReaderCaptureContext,
	PlatformReaderContent,
	PlatformReaderEnhanceContext,
	PlatformStructuredContent,
} from './types';

const platforms: PlatformModule[] = [
	wechatPlatform,
	githubPlatform,
	feishuPlatform,
	bilibiliPlatform,
	xPlatform,
];

function matchingPlatforms(url: string): PlatformModule[] {
	return platforms.filter(platform => platform.matches(url));
}

export const platformRegistry = {
	async beforeDomNormalize(context: PlatformContentContext): Promise<void> {
		for (const platform of matchingPlatforms(context.url)) {
			await platform.beforeDomNormalize?.(context);
		}
	},

	async afterExtract(context: PlatformExtractContext): Promise<any> {
		let parsed = context.parsed;
		for (const platform of matchingPlatforms(context.url)) {
			if (!platform.afterExtract) continue;
			parsed = await platform.afterExtract({ ...context, parsed });
		}
		return parsed;
	},

	async extractStructuredContent(context: PlatformContentContext): Promise<PlatformStructuredContent | null> {
		const merged: PlatformStructuredContent = {};
		let found = false;

		for (const platform of matchingPlatforms(context.url)) {
			const result = await platform.extractStructuredContent?.(context);
			if (!result) continue;
			found = true;
			Object.assign(merged, result);
			if (result.variables) {
				merged.variables = {
					...(merged.variables || {}),
					...result.variables,
				};
			}
		}

		return found ? merged : null;
	},

	async afterMarkdown(context: PlatformMarkdownContext): Promise<PlatformMarkdownResult> {
		let result: PlatformMarkdownResult = { content: context.content };
		for (const platform of matchingPlatforms(context.currentUrl)) {
			const next = await platform.afterMarkdown?.({
				...context,
				content: result.content,
			});
			if (!next) continue;
			result = {
				...result,
				...next,
				debugInfo: {
					...(result.debugInfo || {}),
					...(next.debugInfo || {}),
				},
				prefixMarkdown: `${result.prefixMarkdown || ''}${next.prefixMarkdown || ''}`,
			};
		}
		return result;
	},

	async extractReaderContent(context: PlatformReaderCaptureContext): Promise<PlatformReaderContent | null> {
		for (const platform of matchingPlatforms(context.url)) {
			const result = await platform.extractReaderContent?.(context);
			if (result) return result;
		}
		return null;
	},

	async captureReaderState(context: PlatformReaderCaptureContext): Promise<Record<string, unknown>> {
		const state: Record<string, unknown> = {};
		for (const platform of matchingPlatforms(context.url)) {
			if (!platform.captureReaderState) continue;
			state[platform.id] = await platform.captureReaderState(context);
		}
		return state;
	},

	async enhanceReader(context: PlatformReaderEnhanceContext): Promise<void> {
		for (const platform of matchingPlatforms(context.url)) {
			await platform.enhanceReader?.({
				...context,
				state: (context.state as Record<string, unknown> | undefined)?.[platform.id],
			});
		}
	},

	async onReaderRestore(context: PlatformReaderCaptureContext): Promise<void> {
		for (const platform of matchingPlatforms(context.url)) {
			await platform.onReaderRestore?.(context);
		}
	},
};

export function registerPlatformBackgroundHandlers(): PlatformBackgroundHandler {
	const handlers = platforms.flatMap(platform => platform.registerBackgroundHandlers?.() || []);
	return (context: PlatformBackgroundContext): true | undefined => {
		for (const handler of handlers) {
			const handled = handler(context);
			if (handled) return handled;
		}
		return undefined;
	};
}
