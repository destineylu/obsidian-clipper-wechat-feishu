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

function portableFeishuAttachmentLinks(
	markdown: string,
	sourceUrl: string
): string {
	return markdown.replace(
		/!?\[([^\]]*)\]\(feishu-bridge:\/\/(?:video|file)\/[^)]+\)/g,
		(_match, alt: string) =>
			`[${alt || '飞书视频或附件'}](${sourceUrl})`
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

function largeAttachmentConfirmMessage(attachmentCount: number): string {
	const formattedCount = new Intl.NumberFormat('zh-CN').format(
		attachmentCount
	);
	return [
		`本次剪藏包含 ${formattedCount} 个视频或大附件。下载可能较慢，并占用较多 Vault 空间。`,
		'',
		'点击“确定”：下载到 Obsidian',
		'点击“取消”：视频/附件保留飞书链接，仅将图片保存到本地（推荐）',
	].join('\n');
}

export async function saveFeishuToObsidian(
	context: PlatformObsidianSaveContext
): Promise<PlatformObsidianSaveResult | null> {
	if (!isFeishuDocUrl(context.url)) return null;
	const settings = await loadPlatformSettings();
	if (!isFeishuBridgeEnabled(settings.feishu)) return null;
	const initialAssets = extractFeishuBridgeAssets(context.fileContent);
	if (!initialAssets.length) return null;

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

	let fileContent = context.fileContent;
	const attachmentCount = initialAssets.filter(
		asset => asset.kind !== 'image'
	).length;
	if (
		attachmentCount > 0 &&
		!confirm(largeAttachmentConfirmMessage(attachmentCount))
	) {
		fileContent = portableFeishuAttachmentLinks(
			fileContent,
			context.url
		);
		if (!extractFeishuBridgeAssets(fileContent).length) {
			return {
				handled: false,
				fileContent,
			};
		}
	}

	const notePath = buildNotePath(context.path, context.noteName);
	if (!notePath) throw new Error('Obsidian 笔记名称不能为空');
	const response = await browser.runtime.sendMessage({
		action: 'saveFeishuWithBridge',
		input: {
			fileContent,
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
