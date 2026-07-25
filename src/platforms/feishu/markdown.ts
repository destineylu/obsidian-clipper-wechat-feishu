import { createMarkdownContent } from 'defuddle/full';
import browser from '../../utils/browser-polyfill';
import { escapeHtml } from '../../utils/string-utils';
import { PlatformMarkdownResult } from '../types';
import {
	loadPlatformSettings,
	type FeishuAttachmentMode,
	type FeishuImageMode,
} from '../settings';
import {
	buildFeishuMediaDownloadLinks,
	inlineFeishuMediaPlaceholders,
	isFeishuDocUrl,
	MAX_TOTAL_INLINE_MEDIA_BYTES,
} from './extractor';

const MAX_FEISHU_INLINE_CONCURRENCY = 2;
const MAX_FEISHU_INLINE_DURATION_MS = 60_000;
const FEISHU_IMAGE_SLOW_WARNING_THRESHOLD = 30;
const FEISHU_IMAGE_UNOPENABLE_WARNING_THRESHOLD = 50;

type FeishuMediaInliningPolicy = 'inline' | 'bridge' | 'skip';

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
	if (displayKind === 'video') {
		return `<a href="${escapeHtml(currentUrl)}">${escapeHtml(`${fallbackLabel}：打开原飞书文档`)}</a>`;
	}

	const downloadLinks = buildFeishuMediaDownloadLinks(currentUrl, token, downloadKind);
	const mediaUrl = browser.runtime.getURL(
		`feishu-media.html?kind=${displayKind}&name=${encodeURIComponent(fallbackLabel)}&source=${encodeURIComponent(currentUrl)}&urls=${encodeURIComponent(JSON.stringify(downloadLinks))}`
	);
	return [
		`<a href="${escapeHtml(mediaUrl)}">${escapeHtml(`${fallbackLabel}：当前浏览器打开`)}</a>`,
		`<a href="${escapeHtml(currentUrl)}">${escapeHtml('打开原飞书文档')}</a>`,
	].join(' · ');
}

function replaceUnresolvedFeishuMediaWithFallbacks(content: string, currentUrl: string): string {
	return content
		.replace(/<figure[^>]*>\s*<img[^>]*src="feishu-image:\/\/([\w-]+)(?:\?fallback=[^"]+)?"[^>]*alt="([^"]*)"[^>]*>\s*<\/figure>/gi, (_, token: string, alt: string) => {
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

function getFeishuMediaInliningPolicy(
	content: string,
	imageMode: FeishuImageMode,
	attachmentMode: FeishuAttachmentMode
): FeishuMediaInliningPolicy {
	const { totalPlaceholderCount } = getFeishuMediaPlaceholderSummary(content);
	if (!totalPlaceholderCount) return 'inline';
	if (
		imageMode === 'obsidian-bridge'
		|| attachmentMode === 'obsidian-bridge'
	) {
		return 'bridge';
	}
	return imageMode === 'inline-base64' ? 'inline' : 'skip';
}

function convertFeishuMediaToBridgeMarkers(
	content: string,
	imageMode: FeishuImageMode,
	attachmentMode: FeishuAttachmentMode
): string {
	let nextContent = content;

	if (attachmentMode === 'obsidian-bridge') {
		nextContent = nextContent.replace(
			/<figure[^>]*>\s*<video[^>]*src="feishu-file:\/\/([\w-]+)"[^>]*><\/video>(?:\s*<figcaption>([\s\S]*?)<\/figcaption>)?\s*<\/figure>/gi,
			(_match, token: string, caption: string) => {
				const plainCaption = stripHtml(caption || '') || '飞书视频';
				return `<figure><img src="feishu-bridge://video/${encodeURIComponent(token)}" alt="${escapeHtml(plainCaption)}"></figure>`;
			}
		);
		nextContent = nextContent.replace(
			/<p><a href="feishu-file:\/\/([\w-]+)">([\s\S]*?)<\/a><\/p>/gi,
			(_match, token: string, text: string) => {
				const plainText = stripHtml(text || '') || '飞书附件';
				return `<p><a href="feishu-bridge://file/${encodeURIComponent(token)}">${escapeHtml(plainText)}</a></p>`;
			}
		);
	}

	if (imageMode === 'obsidian-bridge') {
		nextContent = nextContent.replace(
			/(<img\b[^>]*\bsrc=["'])feishu-file:\/\/([\w-]+)(["'][^>]*>)/gi,
			(_match, before: string, token: string, after: string) =>
				`${before}feishu-bridge://image-file/${encodeURIComponent(token)}${after}`
		);
		nextContent = nextContent.replace(
			/feishu-image:\/\/([\w-]+)(?:\?fallback=([^"'\s<>]+))?/g,
			(_match, token: string, encodedFallback?: string) => [
				`feishu-bridge://image/${encodeURIComponent(token)}`,
				encodedFallback ? `?fallback=${encodedFallback}` : '',
			].join('')
		);
	}

	return nextContent;
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

function getFeishuImageBudgetMarkdown(initialImageCount: number, remainingImageCount: number): string {
	if (!remainingImageCount) return '';
	const inlinedImageCount = Math.max(0, initialImageCount - remainingImageCount);
	return [
		'> [!info] 飞书图片下载已按安全预算返回',
		`> 已内联 ${inlinedImageCount} 张飞书图片，剩余 ${remainingImageCount} 张保留为可点击入口。图片较少的文档会尽量全部下载；达到约 1 分钟或总内联体积安全上限后会停止新请求并取消超时下载。`,
		'',
	].join('\n');
}

function getFeishuBridgeMarkdown(
	imageCount: number,
	fileCount: number,
	imageMode: FeishuImageMode,
	attachmentMode: FeishuAttachmentMode
): string {
	if (!imageCount && !fileCount) return '';
	const localParts = [
		imageMode === 'obsidian-bridge' && imageCount
			? `${imageCount} 张图片`
			: '',
		attachmentMode === 'obsidian-bridge' && fileCount
			? `${fileCount} 个视频或附件`
			: '',
	].filter(Boolean);
	if (!localParts.length) return '';
	return [
		'> [!info] 飞书媒体将保存为二进制附件',
		`> ${localParts.join('和')}将在点击“添加到 Obsidian”时通过本机配套插件写入 Vault，不会转为 Base64。`,
		'',
	].join('\n');
}

export async function processFeishuMarkdown(content: string, currentUrl: string): Promise<PlatformMarkdownResult | null> {
	if (!isFeishuDocUrl(currentUrl)) return null;

	const settings = await loadPlatformSettings();
	const placeholderSummary = getFeishuMediaPlaceholderSummary(content);
	const mediaInliningPolicy = getFeishuMediaInliningPolicy(
		content,
		settings.feishu.imageMode,
		settings.feishu.attachmentMode
	);
	let nextContent = content;

	if (
		placeholderSummary.totalPlaceholderCount > 0
		&& settings.feishu.imageMode === 'inline-base64'
	) {
		nextContent = await inlineFeishuMediaPlaceholders(nextContent, currentUrl, {
			maxFiles: 0,
			maxDurationMs: MAX_FEISHU_INLINE_DURATION_MS,
			maxTotalBytes: MAX_TOTAL_INLINE_MEDIA_BYTES,
			concurrency: MAX_FEISHU_INLINE_CONCURRENCY,
		});
	}
	if (mediaInliningPolicy === 'bridge') {
		nextContent = convertFeishuMediaToBridgeMarkers(
			nextContent,
			settings.feishu.imageMode,
			settings.feishu.attachmentMode
		);
	}

	const finalPlaceholderSummary = getFeishuMediaPlaceholderSummary(nextContent);
	const prefixMarkdown = [
		settings.feishu.imageMode === 'inline-base64'
			? getFeishuImageWarningMarkdown(placeholderSummary.imagePlaceholderCount)
			: '',
		settings.feishu.imageMode === 'inline-base64'
			? getFeishuImageBudgetMarkdown(
				placeholderSummary.imagePlaceholderCount,
				finalPlaceholderSummary.imagePlaceholderCount
			)
			: '',
		mediaInliningPolicy === 'bridge'
			? getFeishuBridgeMarkdown(
				placeholderSummary.imagePlaceholderCount,
				placeholderSummary.filePlaceholderCount,
				settings.feishu.imageMode,
				settings.feishu.attachmentMode
			)
			: '',
		settings.feishu.attachmentMode === 'obsidian-bridge'
			? ''
			: getFeishuFileFallbackMarkdown(placeholderSummary.filePlaceholderCount),
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
			feishuMediaInlineMaxTotalBytes: MAX_TOTAL_INLINE_MEDIA_BYTES,
			feishuDownloadImages: settings.feishu.downloadImages,
			feishuImageMode: settings.feishu.imageMode,
			feishuAttachmentMode: settings.feishu.attachmentMode,
		},
	};
}
