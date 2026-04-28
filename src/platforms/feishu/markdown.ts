import { createMarkdownContent } from 'defuddle/full';
import browser from '../../utils/browser-polyfill';
import { escapeHtml } from '../../utils/string-utils';
import { PlatformMarkdownResult } from '../types';
import { loadPlatformSettings } from '../settings';
import {
	buildFeishuMediaDownloadLinks,
	inlineFeishuMediaPlaceholders,
	isFeishuDocUrl,
} from './extractor';

const MAX_FEISHU_INLINE_CONCURRENCY = 2;
const MAX_FEISHU_INLINE_DURATION_MS = 60_000;
const FEISHU_IMAGE_SLOW_WARNING_THRESHOLD = 30;
const FEISHU_IMAGE_UNOPENABLE_WARNING_THRESHOLD = 50;

type FeishuMediaInliningPolicy = 'inline' | 'skip';

function stripHtml(html: string): string {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');
	return doc.body.textContent || '';
}

function buildFeishuVideoBlockPlaceholder(index: number): string {
	return `FEISHUVIDEOBLOCK${index}TOKEN`;
}

function cleanFeishuMediaTitle(title: string | undefined, token: string): string {
	if (!title) return '';
	return title
		.replace(new RegExp(token, 'g'), '')
		.replace(/[（）()【】\[\]\s]+$/g, '')
		.trim();
}

function createFeishuMediaFallback(
	label: string,
	token: string,
	currentUrl: string,
	downloadKind: 'image' | 'file',
	displayKind: 'image' | 'video',
	title?: string
): string {
	const normalizedTitle = cleanFeishuMediaTitle(title, token);
	const fallbackLabel = normalizedTitle ? `${label}：${normalizedTitle}` : label;
	const downloadLinks = buildFeishuMediaDownloadLinks(currentUrl, token, downloadKind);
	const mediaUrl = browser.runtime.getURL(
		`feishu-media.html?kind=${displayKind}&name=${encodeURIComponent(fallbackLabel)}&urls=${encodeURIComponent(JSON.stringify(downloadLinks))}`
	);
	return `<a href="${escapeHtml(mediaUrl)}">${escapeHtml(fallbackLabel)}</a>`;
}

function replaceUnresolvedFeishuMediaWithFallbacks(content: string, currentUrl: string): string {
	return content
		.replace(/<figure[^>]*>\s*<img[^>]*src="feishu-image:\/\/([\w-]+)"[^>]*alt="([^"]*)"[^>]*>\s*<\/figure>/gi, (_, token: string, alt: string) => {
			return `<p>${createFeishuMediaFallback('Feishu图片未内联', token, currentUrl, 'image', 'image', alt)}</p>`;
		})
		.replace(/<figure[^>]*>\s*<img[^>]*src="feishu-file:\/\/([\w-]+)"[^>]*alt="([^"]*)"[^>]*>\s*<\/figure>/gi, (_, token: string, alt: string) => {
			return `<p>${createFeishuMediaFallback('Feishu图片附件未内联', token, currentUrl, 'file', 'image', alt)}</p>`;
		})
		.replace(/<figure[^>]*>\s*<video[^>]*src="feishu-file:\/\/([\w-]+)"[^>]*><\/video>(?:\s*<figcaption>([\s\S]*?)<\/figcaption>)?\s*<\/figure>/gi, (_, token: string, caption: string) => {
			const plainCaption = stripHtml(caption || '');
			return `<p>${createFeishuMediaFallback('Feishu视频未内联', token, currentUrl, 'file', 'video', plainCaption)}</p>`;
		})
		.replace(/<p><a href="feishu-file:\/\/([\w-]+)">([\s\S]*?)<\/a><\/p>/gi, (_, token: string, text: string) => {
			const plainText = stripHtml(text || '');
			return `<p><a href="${escapeHtml(currentUrl)}">${escapeHtml(cleanFeishuMediaTitle(plainText, token) || 'Feishu附件未内联')}</a></p>`;
		});
}

function mergeFeishuMarkdownAndVideoHtml(content: string, currentUrl: string): string {
	const contentWithFallbacks = replaceUnresolvedFeishuMediaWithFallbacks(content, currentUrl);
	const videoPattern = /<figure[^>]*>\s*<video[\s\S]*?<\/video>(?:[\s\S]*?<figcaption>[\s\S]*?<\/figcaption>)?\s*<\/figure>/gi;
	const videoBlocks = Array.from(contentWithFallbacks.matchAll(videoPattern), match => match[0]);
	let htmlWithoutVideos = contentWithFallbacks;

	videoBlocks.forEach((block, index) => {
		htmlWithoutVideos = htmlWithoutVideos.replace(block, `\n\n${buildFeishuVideoBlockPlaceholder(index)}\n\n`);
	});

	let markdownBody = createMarkdownContent(htmlWithoutVideos, currentUrl);
	videoBlocks.forEach((block, index) => {
		markdownBody = markdownBody.replace(buildFeishuVideoBlockPlaceholder(index), block);
	});

	return markdownBody;
}

function getMatchCount(content: string, pattern: RegExp): number {
	return content.match(pattern)?.length || 0;
}

function getFeishuMediaPlaceholderSummary(content: string): {
	imagePlaceholderCount: number;
	filePlaceholderCount: number;
	totalPlaceholderCount: number;
} {
	const imagePlaceholderCount = getMatchCount(content, /feishu-image:\/\//gi);
	const filePlaceholderCount = getMatchCount(content, /feishu-file:\/\//gi);
	return {
		imagePlaceholderCount,
		filePlaceholderCount,
		totalPlaceholderCount: imagePlaceholderCount + filePlaceholderCount,
	};
}

function getFeishuMediaInliningPolicy(content: string, downloadImages: boolean): FeishuMediaInliningPolicy {
	const { totalPlaceholderCount } = getFeishuMediaPlaceholderSummary(content);
	if (!totalPlaceholderCount) return 'inline';
	return downloadImages ? 'inline' : 'skip';
}

function getFeishuImageWarningMarkdown(imageCount: number): string {
	if (imageCount < FEISHU_IMAGE_SLOW_WARNING_THRESHOLD) return '';
	const severity = imageCount >= FEISHU_IMAGE_UNOPENABLE_WARNING_THRESHOLD
		? '有可能导致 Obsidian 无法打开该笔记'
		: '可能导致 Obsidian 打开速度极慢';
	return [
		'> [!warning] 飞书图片数量较多',
		`> 本文档包含约 ${imageCount} 张飞书图片，${severity}。如果出现卡死，请在剪藏器设置中关闭“下载图片”，重新剪藏为图片链接。`,
		'',
	].join('\n');
}

function getFeishuFileFallbackMarkdown(fileCount: number): string {
	if (!fileCount) return '';
	return [
		'> [!info] 飞书视频和附件',
		`> 本文档包含约 ${fileCount} 个飞书视频或附件。为避免笔记体积过大，插件会在剪藏结果中保留可点击入口，而不是直接内联到 Markdown。`,
		'',
	].join('\n');
}

function getFeishuImageTimeoutMarkdown(initialImageCount: number, remainingImageCount: number): string {
	if (!remainingImageCount) return '';
	const inlinedImageCount = Math.max(0, initialImageCount - remainingImageCount);
	return [
		'> [!info] 飞书图片下载已按时间返回',
		`> 已内联 ${inlinedImageCount} 张飞书图片，剩余 ${remainingImageCount} 张保留为可点击入口。图片较少的文档会尽量全部下载；图片特别多或网络较慢时会在约 1 分钟返回，避免剪藏弹窗长时间等待。`,
		'',
	].join('\n');
}

export async function processFeishuMarkdown(content: string, currentUrl: string): Promise<PlatformMarkdownResult | null> {
	if (!isFeishuDocUrl(currentUrl)) return null;

	const settings = await loadPlatformSettings();
	const placeholderSummary = getFeishuMediaPlaceholderSummary(content);
	const mediaInliningPolicy = getFeishuMediaInliningPolicy(content, settings.feishu.downloadImages);
	let nextContent = content;

	if (placeholderSummary.totalPlaceholderCount > 0 && mediaInliningPolicy === 'inline') {
		nextContent = await inlineFeishuMediaPlaceholders(nextContent, currentUrl, {
			maxFiles: 0,
			maxDurationMs: MAX_FEISHU_INLINE_DURATION_MS,
			concurrency: MAX_FEISHU_INLINE_CONCURRENCY,
		});
	}

	const finalPlaceholderSummary = getFeishuMediaPlaceholderSummary(nextContent);
	const prefixMarkdown = [
		settings.feishu.downloadImages ? getFeishuImageWarningMarkdown(placeholderSummary.imagePlaceholderCount) : '',
		settings.feishu.downloadImages ? getFeishuImageTimeoutMarkdown(placeholderSummary.imagePlaceholderCount, finalPlaceholderSummary.imagePlaceholderCount) : '',
		getFeishuFileFallbackMarkdown(placeholderSummary.filePlaceholderCount),
	].join('');

	return {
		content: nextContent,
		markdownBody: mergeFeishuMarkdownAndVideoHtml(nextContent, currentUrl),
		prefixMarkdown,
		debugInfo: {
			initialImagePlaceholderCount: placeholderSummary.imagePlaceholderCount,
			initialFilePlaceholderCount: placeholderSummary.filePlaceholderCount,
			finalImagePlaceholderCount: finalPlaceholderSummary.imagePlaceholderCount,
			finalFilePlaceholderCount: finalPlaceholderSummary.filePlaceholderCount,
			feishuMediaInliningPolicy: mediaInliningPolicy,
			feishuMediaInlineMaxDurationMs: MAX_FEISHU_INLINE_DURATION_MS,
			feishuDownloadImages: settings.feishu.downloadImages,
		},
	};
}
