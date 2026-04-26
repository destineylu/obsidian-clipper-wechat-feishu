import { ExtractedContent } from '../types/types';
import { createMarkdownContent } from 'defuddle/full';
import { sanitizeFileName, escapeHtml } from './string-utils';
import { buildVariables, addSchemaOrgDataToVariables } from './shared';
import browser from './browser-polyfill';
import { debugLog } from './debug';
import dayjs from 'dayjs';
import { AnyHighlightData, TextHighlightData, HighlightData } from './highlighter';
import { generalSettings } from './storage-utils';
import { buildFeishuMediaDownloadLinks, isFeishuDocUrl, inlineFeishuMediaPlaceholders } from '../platforms/feishu/extractor';
import {
	getElementByXPath,
	wrapElementWithMark,
	wrapTextWithMark
} from './dom-utils';

// Define ElementHighlightData type inline since it's not exported from highlighter.ts
interface ElementHighlightData extends HighlightData {
	type: 'element';
}

function canHighlightElement(element: Element): boolean {
	// List of elements that can't be nested inside mark
	const unsupportedElements = ['img', 'video', 'audio', 'iframe', 'canvas', 'svg', 'math', 'table'];

	// Check if the element contains any unsupported elements
	const hasUnsupportedElements = unsupportedElements.some(tag =>
		element.getElementsByTagName(tag).length > 0
	);

	// Check if the element itself is an unsupported type
	const isUnsupportedType = unsupportedElements.includes(element.tagName.toLowerCase());

	return !hasUnsupportedElements && !isUnsupportedType;
}

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

const MAX_FEISHU_INLINE_CONCURRENCY = 2;
const FEISHU_IMAGE_SLOW_WARNING_THRESHOLD = 30;
const FEISHU_IMAGE_UNOPENABLE_WARNING_THRESHOLD = 50;

type FeishuMediaInliningPolicy = 'inline' | 'skip';

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

interface ContentResponse {
	content: string;
	selectedHtml: string;
	extractedContent: ExtractedContent;
	schemaOrgData: any;
	fullHtml: string;
	highlights: AnyHighlightData[];
	title: string;
	author: string;
	description: string;
	domain: string;
	favicon: string;
	image: string;
	parseTime: number;
	published: string;
	site: string;
	wordCount: number;
	language: string;
	metaTags: { name?: string | null; property?: string | null; content: string | null }[];
}

async function sendExtractRequest(tabId: number): Promise<ContentResponse> {
	const response = await browser.runtime.sendMessage({
		action: "sendMessageToTab",
		tabId: tabId,
		message: { action: "getPageContent" }
	}) as ContentResponse & { success?: boolean; error?: string };

	// Check for explicit error from background script
	if (response && 'success' in response && !response.success && response.error) {
		throw new Error(response.error);
	}

	if (response && response.content) {
		// Ensure highlights are of the correct type
		if (response.highlights && Array.isArray(response.highlights)) {
			response.highlights = response.highlights.map((highlight: string | AnyHighlightData) => {
				if (typeof highlight === 'string') {
					return {
						type: 'text',
						id: Date.now().toString(),
						xpath: '',
						content: `<div>` + highlight + `</div>`,
						startOffset: 0,
						endOffset: highlight.length
					};
				}
				return highlight as AnyHighlightData;
			});
		} else {
			response.highlights = [];
		}
		return response;
	}

	throw new Error('No content received from page');
}

export async function extractPageContent(tabId: number): Promise<ContentResponse | null> {
	try {
		return await sendExtractRequest(tabId);
	} catch (firstError) {
		// First attempt failed — this commonly happens on Safari after an
		// extension update when a zombie content script (runtime invalidated)
		// responded to ping, preventing re-injection. Force a fresh injection
		// so the new generation's listener takes over, then retry.
		console.log('[Obsidian Clipper] First extraction attempt failed, retrying...', firstError);
		try {
			await browser.runtime.sendMessage({ action: "forceInjectContentScript", tabId });
		} catch {
			// If force-inject fails, proceed anyway — the retry may still work.
		}
		try {
			return await sendExtractRequest(tabId);
		} catch (retryError) {
			console.error('[Obsidian Clipper] Extraction failed after retry:', retryError);
			throw new Error('Web Clipper was not able to start. Please try reloading the page.');
		}
	}
}

export async function initializePageContent(
	content: string,
	selectedHtml: string,
	extractedContent: ExtractedContent,
	currentUrl: string,
	schemaOrgData: any,
	fullHtml: string,
	highlights: AnyHighlightData[],
	title: string,
	author: string,
	description: string,
	favicon: string,
	image: string,
	published: string,
	site: string,
	wordCount: number,
	language: string,
	metaTags: { name?: string | null; property?: string | null; content: string | null }[]
) {
	try {
		currentUrl = currentUrl.replace(/#:~:text=[^&]+(&|$)/, '');

		let selectedMarkdown = '';
		if (selectedHtml) {
			content = selectedHtml;
			selectedMarkdown = createMarkdownContent(selectedHtml, currentUrl);
		}

		// Process highlights after getting the base content
		if (generalSettings.highlighterEnabled && generalSettings.highlightBehavior !== 'no-highlights' && highlights && highlights.length > 0) {
			content = processHighlights(content, highlights);
		}

		const isFeishu = isFeishuDocUrl(currentUrl);
		const feishuPlaceholderSummary = isFeishu
			? getFeishuMediaPlaceholderSummary(content)
			: { imagePlaceholderCount: 0, filePlaceholderCount: 0, totalPlaceholderCount: 0 };
		const feishuMediaInliningPolicy = isFeishu
			? getFeishuMediaInliningPolicy(content, generalSettings.feishuDownloadImages)
			: 'inline';

		if (isFeishu && feishuPlaceholderSummary.totalPlaceholderCount > 0) {
			if (feishuMediaInliningPolicy === 'inline') {
				content = await inlineFeishuMediaPlaceholders(content, currentUrl, {
					maxFiles: 0,
					concurrency: MAX_FEISHU_INLINE_CONCURRENCY,
				});
			}
		}

		const markdownBody = isFeishu
			? mergeFeishuMarkdownAndVideoHtml(content, currentUrl)
			: createMarkdownContent(content, currentUrl);
		const feishuMediaNote = isFeishu
			? [
				generalSettings.feishuDownloadImages ? getFeishuImageWarningMarkdown(feishuPlaceholderSummary.imagePlaceholderCount) : '',
				getFeishuFileFallbackMarkdown(feishuPlaceholderSummary.filePlaceholderCount),
			].join('')
			: '';
		const finalMarkdownBody = feishuMediaNote
			? `${feishuMediaNote}${markdownBody}`
			: markdownBody;
		if (isFeishu) {
			const finalPlaceholderSummary = getFeishuMediaPlaceholderSummary(content);
			console.log('[Feishu Clipper] Final content variable summary:', {
				url: currentUrl,
				contentLength: content.length,
				markdownBodyLength: finalMarkdownBody.length,
				imgCount: (content.match(/<img\b/gi) || []).length,
				videoCount: (content.match(/<video\b/gi) || []).length,
				initialImagePlaceholderCount: feishuPlaceholderSummary.imagePlaceholderCount,
				initialFilePlaceholderCount: feishuPlaceholderSummary.filePlaceholderCount,
				finalImagePlaceholderCount: finalPlaceholderSummary.imagePlaceholderCount,
				finalFilePlaceholderCount: finalPlaceholderSummary.filePlaceholderCount,
				feishuMediaInliningPolicy,
				feishuDownloadImages: generalSettings.feishuDownloadImages,
				usingStructuredHtmlAsContent: false,
			});
		}

		// Convert each highlight to markdown individually
		const highlightsData = highlights.map(highlight => {
			const highlightData: {
				text: string;
				timestamp: string;
				notes?: string[];
			} = {
				text: createMarkdownContent(highlight.content, currentUrl),
				timestamp: dayjs(parseInt(highlight.id)).toISOString(),
			};

			if (highlight.notes && highlight.notes.length > 0) {
				highlightData.notes = highlight.notes;
			}

			return highlightData;
		});

		const noteName = sanitizeFileName(title);

		const currentVariables = buildVariables({
			title,
			author,
			content: finalMarkdownBody,
			contentHtml: content,
			url: currentUrl,
			fullHtml,
			description,
			favicon,
			image,
			published,
			site,
			language,
			wordCount,
			selection: selectedMarkdown,
			selectionHtml: selectedHtml,
			highlights: highlights.length > 0 ? JSON.stringify(highlightsData) : '',
			schemaOrgData,
			metaTags,
			extractedContent,
		});

		debugLog('Variables', 'Available variables:', currentVariables);

		return {
			noteName,
			currentVariables
		};
	} catch (error: unknown) {
		console.error('Error in initializePageContent:', error);
		if (error instanceof Error) {
			throw new Error(`Unable to initialize page content: ${error.message}`);
		} else {
			throw new Error('Unable to initialize page content: Unknown error');
		}
	}
}

function processHighlights(content: string, highlights: AnyHighlightData[]): string {
	// First check if highlighter is enabled and we have highlights
	if (!generalSettings.highlighterEnabled || !highlights?.length) {
		return content;
	}

	// Then check the behavior setting
	if (generalSettings.highlightBehavior === 'no-highlights') {
		return content;
	}

	if (generalSettings.highlightBehavior === 'replace-content') {
		return highlights.map(highlight => highlight.content).join('');
	}

	if (generalSettings.highlightBehavior === 'highlight-inline') {
		debugLog('Highlights', 'Using content length:', content.length);

		const parser = new DOMParser();
		const doc = parser.parseFromString(content, 'text/html');
		const tempDiv = doc.body;

		const textHighlights = filterAndSortHighlights(highlights);
		debugLog('Highlights', 'Processing highlights:', textHighlights.length);

		for (const highlight of textHighlights) {
			processHighlight(highlight, tempDiv as HTMLDivElement);
		}

		// Serialize back to HTML
		const serializer = new XMLSerializer();
		let result = '';
		Array.from(tempDiv.childNodes).forEach(node => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				result += serializer.serializeToString(node);
			} else if (node.nodeType === Node.TEXT_NODE) {
				result += node.textContent;
			}
		});

		return result;
	}

	// Default fallback
	return content;
}

function filterAndSortHighlights(highlights: AnyHighlightData[]): (TextHighlightData | ElementHighlightData)[] {
	return highlights
		.filter((h): h is (TextHighlightData | ElementHighlightData) => {
			if (h.type === 'text') {
				return !!(h.xpath?.trim() || h.content?.trim());
			}
			if (h.type === 'element' && h.xpath?.trim()) {
				const element = getElementByXPath(h.xpath);
				return element ? canHighlightElement(element) : false;
			}
			return false;
		})
		.sort((a, b) => {
			if (a.xpath && b.xpath) {
				const elementA = getElementByXPath(a.xpath);
				const elementB = getElementByXPath(b.xpath);
				if (elementA === elementB && a.type === 'text' && b.type === 'text') {
					return b.startOffset - a.startOffset;
				}
			}
			return 0;
		});
}

function processHighlight(highlight: TextHighlightData | ElementHighlightData, tempDiv: HTMLDivElement) {
	try {
		if (highlight.xpath) {
			processXPathHighlight(highlight, tempDiv);
		} else {
			processContentBasedHighlight(highlight, tempDiv);
		}
	} catch (error) {
		debugLog('Highlights', 'Error processing highlight:', error);
	}
}

function processXPathHighlight(highlight: TextHighlightData | ElementHighlightData, tempDiv: HTMLDivElement) {
	const element = document.evaluate(
		highlight.xpath,
		tempDiv,
		null,
		XPathResult.FIRST_ORDERED_NODE_TYPE,
		null
	).singleNodeValue as Element;

	if (!element) {
		debugLog('Highlights', 'Could not find element for xpath:', highlight.xpath);
		return;
	}

	if (highlight.type === 'element') {
		wrapElementWithMark(element);
	} else {
		wrapTextWithMark(element, highlight as TextHighlightData);
	}
}

function processContentBasedHighlight(highlight: TextHighlightData | ElementHighlightData, tempDiv: HTMLDivElement) {
	const parser = new DOMParser();
	const doc = parser.parseFromString(highlight.content, 'text/html');
	const contentDiv = doc.body;

	// Serialize the inner content
	const serializer = new XMLSerializer();
	let innerContent = '';

	if (contentDiv.children.length === 1 && contentDiv.firstElementChild?.tagName === 'DIV') {
		Array.from(contentDiv.firstElementChild.childNodes).forEach(node => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				innerContent += serializer.serializeToString(node);
			} else if (node.nodeType === Node.TEXT_NODE) {
				innerContent += node.textContent;
			}
		});
	} else {
		Array.from(contentDiv.childNodes).forEach(node => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				innerContent += serializer.serializeToString(node);
			} else if (node.nodeType === Node.TEXT_NODE) {
				innerContent += node.textContent;
			}
		});
	}

	const paragraphs = Array.from(contentDiv.querySelectorAll('p'));
	if (paragraphs.length) {
		processContentParagraphs(paragraphs, tempDiv);
	} else {
		processInlineContent(innerContent, tempDiv);
	}
}

function processContentParagraphs(sourceParagraphs: Element[], tempDiv: HTMLDivElement) {
	sourceParagraphs.forEach(sourceParagraph => {
		const sourceText = stripHtml(sourceParagraph.outerHTML).trim();
		debugLog('Highlights', 'Looking for paragraph:', sourceText);

		const paragraphs = Array.from(tempDiv.querySelectorAll('p'));
		for (const targetParagraph of paragraphs) {
			const targetText = stripHtml(targetParagraph.outerHTML).trim();

			if (targetText === sourceText) {
				debugLog('Highlights', 'Found matching paragraph:', targetParagraph.outerHTML);
				wrapElementWithMark(targetParagraph);
				break;
			}
		}
	});
}

function processInlineContent(content: string, tempDiv: HTMLDivElement) {
	const searchText = stripHtml(content).trim();
	debugLog('Highlights', 'Searching for text:', searchText);

	const walker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT);

	let node;
	while (node = walker.nextNode() as Text) {
		const nodeText = node.textContent || '';
		const index = nodeText.indexOf(searchText);

		if (index !== -1) {
			debugLog('Highlights', 'Found matching text in node:', {
				text: nodeText,
				index: index
			});

			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + searchText.length);

			const mark = document.createElement('mark');
			range.surroundContents(mark);
			debugLog('Highlights', 'Created mark element:', mark.outerHTML);
			break;
		}
	}
}
