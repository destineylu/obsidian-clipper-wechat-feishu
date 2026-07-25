import { sanitizeFileName } from '../../utils/string-utils';
import browser from '../../utils/browser-polyfill';
import type {
	PlatformObsidianSaveContext,
	PlatformObsidianSaveResult,
} from '../types';
import {
	isFeishuBridgeEnabled,
	loadPlatformSettings,
} from '../settings';
import { extractFeishuBridgeAssets } from './bridge-protocol';
import { isFeishuDocUrl } from './extractor';

function portableFeishuBridgeLinks(markdown: string, sourceUrl: string): string {
	return markdown.replace(
		/!?\[([^\]]*)\]\(feishu-bridge:\/\/(?:image|image-file|video|file)\/[^)]+\)/g,
		(_match, alt: string) => `[${alt || '飞书媒体'}](${sourceUrl})`
	);
}

function buildNotePath(path: string, noteName: string): string {
	const folder = path
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.trim();
	const name = sanitizeFileName(noteName).trim();
	return folder ? `${folder}/${name}` : name;
}

export async function saveFeishuToObsidian(
	context: PlatformObsidianSaveContext
): Promise<PlatformObsidianSaveResult | null> {
	if (!isFeishuDocUrl(context.url)) return null;
	const settings = await loadPlatformSettings();
	if (!isFeishuBridgeEnabled(settings.feishu)) return null;
	if (!extractFeishuBridgeAssets(context.fileContent).length) return null;

	if (
		context.behavior === 'append-daily' ||
		context.behavior === 'prepend-daily'
	) {
		return {
			handled: false,
			fileContent: portableFeishuBridgeLinks(
				context.fileContent,
				context.url
			),
		};
	}

	const notePath = buildNotePath(context.path, context.noteName);
	if (!notePath) throw new Error('Obsidian 笔记名称不能为空');
	const response = await browser.runtime.sendMessage({
		action: 'saveFeishuWithBridge',
		input: {
			fileContent: context.fileContent,
			notePath,
			behavior: context.behavior,
			sourceUrl: context.url,
			vault: context.vault,
		},
	}) as {
		success?: boolean;
		data?: { notePath?: string };
		error?: string;
	};

	if (!response?.success) {
		throw new Error(response?.error || 'Obsidian 配套插件保存失败');
	}
	return {
		handled: true,
		notePath: response.data?.notePath || notePath,
	};
}
