import browser from '../../utils/browser-polyfill';
import { createMarkdownContent } from 'defuddle/full';
import { PlatformMarkdownResult, PlatformStructuredContent } from '../types';

interface XVideoVariant {
	bitrate?: number;
	content_type?: string;
	url?: string;
}

interface XVideoCandidate {
	id: string;
	poster?: string;
	url: string;
	bitrate?: number;
	contentType?: string;
	source: string;
}

interface XThreadArticleSnapshot {
	html: string;
	statusUrl: string;
	text: string;
}

interface XThreadSnapshot {
	author: string;
	content: string;
	image: string;
	pageUrl: string;
	published: string;
	title: string;
	wordCount: number;
}

const X_STATUS_PATTERN = /^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i;
const VIDEO_URL_PATTERN = /^https:\/\/video\.twimg\.com\/.+\.(?:mp4|m3u8)(?:[?#].*)?$/i;
const SHOW_MORE_PATTERN = /\bshow more\b|\bread more\b|显示更多|查看更多|展开全文|展开更多|查看全部/i;
const SHOW_MORE_EXCLUDE_PATTERN = /\bshow more repl(?:y|ies)\b|\breplies\b|\breply\b|\bcomments?\b|\bmore menu\b|回复|评论|更多菜单/i;
const X_MEDIA_IMAGE_PATTERN = /^https:\/\/pbs\.twimg\.com\/media\//i;
const X_VIDEO_FETCH_TIMEOUT_MS = 2500;
let xThreadSnapshot: XThreadSnapshot | null = null;

export function isXStatusUrl(url: string): boolean {
	return X_STATUS_PATTERN.test(url);
}

const wait = (durationMs: number) => new Promise(resolve => setTimeout(resolve, durationMs));

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function decodeHtmlAttribute(value: string): string {
	const textarea = document.createElement('textarea');
	textarea.innerHTML = value;
	return textarea.value;
}

function getTweetId(url: string): string | null {
	return url.match(X_STATUS_PATTERN)?.[1] || null;
}

function normalizeXStatusUrl(value: string, baseUrl = 'https://x.com/'): string {
	try {
		const parsed = new URL(value, baseUrl);
		const match = parsed.href.match(X_STATUS_PATTERN);
		if (!match) return '';
		const parts = parsed.pathname.split('/').filter(Boolean);
		if (parts.length < 3 || parts[1] !== 'status') return '';
		return `https://x.com/${parts[0]}/status/${match[1]}`;
	} catch {
		return '';
	}
}

function getXStatusAuthor(url: string): string | null {
	try {
		const parsed = new URL(url);
		const parts = parsed.pathname.split('/').filter(Boolean);
		return parts.length >= 3 && parts[1] === 'status' ? parts[0].toLowerCase() : null;
	} catch {
		return null;
	}
}

function normalizeXMediaImageUrl(value: string): string {
	try {
		const parsed = new URL(decodeHtmlAttribute(value));
		if (!X_MEDIA_IMAGE_PATTERN.test(parsed.href)) return '';
		if (parsed.searchParams.has('name')) {
			parsed.searchParams.set('name', 'large');
		}
		return parsed.href;
	} catch {
		return '';
	}
}

function dedupePreserveOrder<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function findTweetObjects(root: unknown, tweetId: string): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	const seen = new Set<unknown>();
	const stack: unknown[] = [root];

	while (stack.length) {
		const current = stack.pop();
		if (!isObject(current) || seen.has(current)) continue;
		seen.add(current);

		if (current.id_str === tweetId || current.rest_id === tweetId) {
			found.push(current);
		}

		for (const value of Object.values(current)) {
			if (isObject(value) || Array.isArray(value)) {
				stack.push(value);
			}
		}
	}

	return found;
}

function collectMediaObjects(root: unknown): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	const seen = new Set<unknown>();
	const stack: unknown[] = [root];

	while (stack.length) {
		const current = stack.pop();
		if (!isObject(current) || seen.has(current)) continue;
		seen.add(current);

		if (current.type === 'video' || current.type === 'animated_gif' || isObject(current.video_info)) {
			found.push(current);
		}

		for (const value of Object.values(current)) {
			if (isObject(value) || Array.isArray(value)) {
				stack.push(value);
			}
		}
	}

	return found;
}

function normalizeVideoUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.searchParams.delete('container');
		return parsed.href;
	} catch {
		return url;
	}
}

function isPlayableXVideoUrl(url: string): boolean {
	if (!VIDEO_URL_PATTERN.test(url)) return false;
	return !/\/aud\//i.test(url);
}

function chooseBestVariant(variants: XVideoVariant[]): XVideoVariant | null {
	const usable = variants
		.filter(variant => variant.url
			&& variant.content_type !== 'audio/mp4'
			&& isPlayableXVideoUrl(variant.url))
		.sort((left, right) => {
			const leftIsMp4 = left.content_type === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(left.url || '');
			const rightIsMp4 = right.content_type === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(right.url || '');
			if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
			return (right.bitrate || 0) - (left.bitrate || 0);
		});
	return usable[0] || null;
}

function parseJsonAssignment(source: string, marker: string): unknown | null {
	const markerIndex = source.indexOf(marker);
	if (markerIndex < 0) return null;

	const start = source.indexOf('{', markerIndex + marker.length);
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(source.slice(start, index + 1));
				} catch {
					return null;
				}
			}
		}
	}

	return null;
}

function getInitialState(): unknown | null {
	const pageState = (window as typeof window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
	if (pageState) return pageState;

	for (const script of Array.from(document.scripts)) {
		const text = script.textContent || '';
		if (!text.includes('__INITIAL_STATE__')) continue;
		const parsed = parseJsonAssignment(text, 'window.__INITIAL_STATE__=')
			|| parseJsonAssignment(text, '__INITIAL_STATE__=');
		if (parsed) return parsed;
	}

	return null;
}

function candidateFromMediaObject(media: Record<string, unknown>, source: string): XVideoCandidate | null {
	const videoInfo = media.video_info;
	if (!isObject(videoInfo) || !Array.isArray(videoInfo.variants)) return null;

	const variant = chooseBestVariant(videoInfo.variants as XVideoVariant[]);
	if (!variant?.url) return null;

	const id = String(media.id_str || media.media_key || variant.url);
	const poster = typeof media.media_url_https === 'string'
		? media.media_url_https
		: typeof media.media_url === 'string'
			? media.media_url
			: undefined;

	return {
		id,
		poster,
		url: normalizeVideoUrl(variant.url),
		bitrate: variant.bitrate,
		contentType: variant.content_type,
		source,
	};
}

function extractFromInitialState(tweetId: string): XVideoCandidate[] {
	const state = getInitialState();
	if (!state) return [];

	const tweetObjects = findTweetObjects(state, tweetId);
	const candidates = tweetObjects
		.flatMap(tweet => collectMediaObjects(tweet))
		.map(media => candidateFromMediaObject(media, 'initial-state'))
		.filter((candidate): candidate is XVideoCandidate => !!candidate);

	return dedupeCandidates(candidates);
}

function extractFromDom(): XVideoCandidate[] {
	return Array.from(document.querySelectorAll<HTMLVideoElement>('article video'))
		.map((video, index): XVideoCandidate | null => {
			const source = video.currentSrc || video.src || video.querySelector('source')?.src || '';
			if (!source || source.startsWith('blob:')) return null;
			if (!isPlayableXVideoUrl(source)) return null;
			return {
				id: source,
				poster: video.poster || undefined,
				url: normalizeVideoUrl(source),
				source: `dom-${index}`,
			};
		})
		.filter((candidate): candidate is XVideoCandidate => !!candidate);
}

function extractFromPerformance(): XVideoCandidate[] {
	return performance.getEntriesByType('resource')
		.map(entry => entry.name)
		.filter(url => isPlayableXVideoUrl(url))
		.filter(url => /\.mp4(?:[?#]|$)/i.test(url) || /\.m3u8(?:[?#]|$)/i.test(url))
		.map((url): XVideoCandidate => {
			const sizeMatch = url.match(/\/(\d+)x(\d+)\//);
			const bitrateMatch = url.match(/\/(?:mp4a|avc1)\/(?:\d+\/\d+\/)?(\d+)\//);
			const sizeScore = sizeMatch ? Number(sizeMatch[1]) * Number(sizeMatch[2]) : 0;
			return {
				id: url,
				url: normalizeVideoUrl(url),
				bitrate: bitrateMatch ? Number(bitrateMatch[1]) : sizeScore,
				contentType: /\.mp4(?:[?#]|$)/i.test(url) ? 'video/mp4' : 'application/x-mpegURL',
				source: 'performance',
			};
		});
}

function dedupeCandidates(candidates: XVideoCandidate[]): XVideoCandidate[] {
	const byUrl = new Map<string, XVideoCandidate>();
	for (const candidate of candidates) {
		if (!candidate.url) continue;
		const existing = byUrl.get(candidate.url);
		if (!existing || (candidate.bitrate || 0) > (existing.bitrate || 0)) {
			byUrl.set(candidate.url, candidate);
		}
	}
	return Array.from(byUrl.values());
}

function chooseBestCandidate(candidates: XVideoCandidate[]): XVideoCandidate | null {
	const sorted = dedupeCandidates(candidates).sort((left, right) => {
		const leftIsMp4 = left.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(left.url);
		const rightIsMp4 = right.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(right.url);
		if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
		return (right.bitrate || 0) - (left.bitrate || 0);
	});
	return sorted[0] || null;
}

async function extractFromMainWorld(url: string): Promise<XVideoCandidate | null> {
	const response = await Promise.race([
		browser.runtime.sendMessage({
			action: 'xExtractVideoCandidate',
			url,
		}).catch(() => null),
		wait(X_VIDEO_FETCH_TIMEOUT_MS).then(() => null),
	]) as { success?: boolean; candidate?: XVideoCandidate | null } | null;
	return response?.success ? response.candidate || null : null;
}

function getVisibleText(element: Element): string {
	return [
		(element as HTMLElement).innerText,
		element.textContent,
		element.getAttribute('aria-label'),
		element.getAttribute('title'),
	].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function getPrimaryTweetScope(doc: Document): Element {
	const longform = doc.querySelector('[data-testid="longformRichTextComponent"]');
	const mainTweet = longform?.closest('article')
		|| doc.querySelector('main article')
		|| doc.querySelector('article')
		|| doc.body;
	return mainTweet;
}

function hasXVideoMedia(root: ParentNode): boolean {
	return !!root.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]');
}

function getXArticleStatusUrls(article: Element, baseUrl: string): string[] {
	return dedupePreserveOrder(Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
		.map(anchor => normalizeXStatusUrl(anchor.getAttribute('href') || anchor.href, baseUrl))
		.filter(Boolean));
}

function getXArticlePrimaryStatusUrl(article: Element, baseUrl: string): string {
	return getXArticleStatusUrls(article, baseUrl)[0] || '';
}

function isXArticleByAuthor(article: Element, author: string | null, baseUrl: string): boolean {
	if (!author) return false;
	return getXArticleStatusUrls(article, baseUrl).some(url => getXStatusAuthor(url) === author);
}

function getXShowMoreControls(scope: Element): HTMLElement[] {
	return Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"], a[href]'))
		.filter((control) => {
			const text = getVisibleText(control);
			const testId = control.getAttribute('data-testid') || '';
			if (testId !== 'tweet-text-show-more-link' && !SHOW_MORE_PATTERN.test(text)) return false;
			if (SHOW_MORE_EXCLUDE_PATTERN.test(text)) return false;
			return !control.closest('[aria-label*="Reply"], [aria-label*="reply"]');
		});
}

async function expandXShowMoreInScope(scope: Element, maxClicks = 8, maxRounds = 2): Promise<number> {
	let clickedCount = 0;

	for (let round = 0; round < maxRounds && clickedCount < maxClicks; round++) {
		const targets = getXShowMoreControls(scope).slice(0, maxClicks - clickedCount);
		if (targets.length === 0) break;

		for (const target of targets) {
			target.click();
			clickedCount++;
		}
		await wait(250);
	}

	return clickedCount;
}

async function expandXPrimaryShowMore(doc: Document): Promise<number> {
	return expandXShowMoreInScope(getPrimaryTweetScope(doc));
}

async function expandXThreadShowMore(doc: Document, pageUrl: string): Promise<number> {
	const author = getXStatusAuthor(pageUrl);
	const articles = Array.from(doc.querySelectorAll<HTMLElement>('article'))
		.filter(article => isXArticleByAuthor(article, author, pageUrl));
	let clickedCount = 0;
	for (let round = 0; round < 2; round++) {
		const targets = articles
			.flatMap(article => getXShowMoreControls(article))
			.slice(0, 12 - clickedCount);
		if (targets.length === 0) break;

		for (const target of targets) {
			target.click();
			clickedCount++;
		}
		await wait(250);
		if (clickedCount >= 12) break;
	}
	return clickedCount;
}

function collectVisibleXThreadArticles(
	doc: Document,
	pageUrl: string,
	articlesByUrl: Map<string, XThreadArticleSnapshot>,
	state: { started: boolean; seenNonAuthor: boolean }
): void {
	const author = getXStatusAuthor(pageUrl);
	if (!author) return;
	const pageStatusUrl = normalizeXStatusUrl(pageUrl);

	for (const article of Array.from(doc.querySelectorAll<HTMLElement>('article'))) {
		const statusUrl = getXArticlePrimaryStatusUrl(article, pageUrl);
		if (!statusUrl) continue;
		const existing = articlesByUrl.get(statusUrl);
		const articleAuthor = getXStatusAuthor(statusUrl);
		const isTarget = statusUrl === pageStatusUrl;
		const isSameAuthor = articleAuthor === author;

		if (!state.started && isTarget) {
			state.started = true;
		}
		if (!state.started) continue;
		if (!isSameAuthor) {
			state.seenNonAuthor = true;
			continue;
		}

		const snapshot = {
			html: buildXArticleStructuredHtml(article, pageUrl),
			statusUrl,
			text: article.innerText || '',
		};
		if (!existing || snapshot.text.length > existing.text.length + 20) {
			articlesByUrl.set(statusUrl, {
				html: snapshot.html,
				statusUrl: snapshot.statusUrl,
				text: snapshot.text,
			});
		}
	}
}

function saveXThreadSnapshot(pageUrl: string, articlesByUrl: Map<string, XThreadArticleSnapshot>): void {
	const articles = Array.from(articlesByUrl.values());
	if (articles.length <= 1) {
		xThreadSnapshot = null;
		return;
	}
	const first = articles[0];
	const content = `<div class="tweet-thread x-structured-thread">${articles.map(article => article.html).join('<hr>')}</div>`;
	const mediaImages = extractXMediaImagesFromHtml(content);
	xThreadSnapshot = {
		author: getXStatusAuthor(pageUrl) || '',
		content,
		image: mediaImages[0] || '',
		pageUrl: normalizeXStatusUrl(pageUrl),
		published: '',
		title: extractXArticleTitleFromText(first.text, pageUrl),
		wordCount: articles.map(article => article.text).join('\n').split(/\s+/).filter(Boolean).length,
	};
}

export async function hydrateXMediaBeforeExtract(doc: Document): Promise<void> {
	const win = doc.defaultView;
	const pageUrl = doc.URL || win?.location.href || '';
	if (!win || !isXStatusUrl(pageUrl)) return;
	if (!doc.querySelector('[data-testid="longformRichTextComponent"], article, video')) return;
	xThreadSnapshot = null;

	const startedAt = Date.now();
	const maxDurationMs = 8000;
	const hasTimeBudget = () => Date.now() - startedAt < maxDurationMs;
	const threadArticles = new Map<string, XThreadArticleSnapshot>();
	const threadState = { started: false, seenNonAuthor: false };
	const originalY = win.scrollY;
	try {
		await expandXPrimaryShowMore(doc);
		if (hasTimeBudget()) await expandXThreadShowMore(doc, pageUrl);
		collectVisibleXThreadArticles(doc, pageUrl, threadArticles, threadState);
		const hasLongform = !!doc.querySelector('[data-testid="longformRichTextComponent"]');
		const maxSteps = hasLongform ? 8 : 6;
		let previousScrollHeight = doc.body?.scrollHeight || 0;
		let previousArticleCount = doc.querySelectorAll('article').length;
		let previousSameAuthorCount = threadArticles.size;
		let stagnantSteps = 0;
		let noNewSameAuthorSteps = 0;

		for (let index = 0; index < maxSteps && hasTimeBudget(); index++) {
			win.scrollBy(0, Math.max(500, Math.floor(win.innerHeight * 0.75)));
			await wait(250);
			if (hasTimeBudget()) await expandXThreadShowMore(doc, pageUrl);
			collectVisibleXThreadArticles(doc, pageUrl, threadArticles, threadState);

			const nextScrollHeight = doc.body?.scrollHeight || 0;
			const nextArticleCount = doc.querySelectorAll('article').length;
			if (threadArticles.size > previousSameAuthorCount) {
				noNewSameAuthorSteps = 0;
			} else {
				noNewSameAuthorSteps++;
			}
			const nearPageEnd = win.scrollY + win.innerHeight >= nextScrollHeight - 120;
			if (nearPageEnd && nextScrollHeight <= previousScrollHeight + 40 && nextArticleCount <= previousArticleCount) {
				stagnantSteps++;
				if (stagnantSteps >= 2) break;
			} else {
				stagnantSteps = 0;
			}
			if (!hasLongform && stateReachedThreadTail(threadState, threadArticles.size, noNewSameAuthorSteps, index)) {
				break;
			}
			previousScrollHeight = nextScrollHeight;
			previousArticleCount = nextArticleCount;
			previousSameAuthorCount = threadArticles.size;
		}
	} finally {
		collectVisibleXThreadArticles(doc, pageUrl, threadArticles, threadState);
		saveXThreadSnapshot(pageUrl, threadArticles);
		win.scrollTo(0, originalY);
		if (hasTimeBudget()) await wait(100);
	}
}

function stateReachedThreadTail(
	threadState: { started: boolean; seenNonAuthor: boolean },
	sameAuthorCount: number,
	noNewSameAuthorSteps: number,
	stepIndex: number
): boolean {
	if (!threadState.started) return false;
	if (sameAuthorCount <= 1 && stepIndex < 3) return false;
	if (threadState.seenNonAuthor && noNewSameAuthorSteps >= 2) return true;
	return sameAuthorCount <= 1 && noNewSameAuthorSteps >= 4;
}

function getXTargetArticle(doc: Document, pageUrl: string): HTMLElement | null {
	const tweetId = getTweetId(pageUrl);
	const articles = Array.from(doc.querySelectorAll<HTMLElement>('article'));
	if (!tweetId) return articles[0] || null;

	return articles.find(article => Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
		.some(anchor => normalizeXStatusUrl(anchor.getAttribute('href') || anchor.href, pageUrl).endsWith(`/status/${tweetId}`)))
		|| articles.find(article => article.querySelector('[data-testid="longformRichTextComponent"]'))
		|| articles[0]
		|| null;
}

function extractXArticleTitle(article: HTMLElement, pageUrl: string): string {
	return extractXArticleTitleFromText(article.innerText || '', pageUrl);
}

function extractXArticleTitleFromText(text: string, pageUrl: string): string {
	const author = getXStatusAuthor(pageUrl);
	const lines = text
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean);
	const handleIndex = author
		? lines.findIndex(line => line.toLowerCase() === `@${author}`.toLowerCase())
		: -1;
	const candidateLines = handleIndex >= 0 ? lines.slice(handleIndex + 1) : lines;
	const title = candidateLines.find((line) => {
		if (line.startsWith('@')) return false;
		if (author && line.toLowerCase() === author.toLowerCase()) return false;
		if (/^[\d,.]+[KMB万千]?$/.test(line)) return false;
		if (/^(subscribe|follow|following|reply|repost|like|view|views|bookmark|share|quote)$/i.test(line)) return false;
		if (/^·$/.test(line)) return false;
		if (/^\d+[smhdwy]$/i.test(line)) return false;
		return line.length > 6;
	});
	return title || docTitleFallback();
}

function docTitleFallback(): string {
	return document.title.replace(/\s*\/\s*X\s*$/i, '').replace(/\s*on X\s*$/i, '').trim();
}

function extractXMediaImagesFromElement(element: Element): string[] {
	return dedupePreserveOrder(Array.from(element.querySelectorAll<HTMLImageElement>('img'))
		.map(img => normalizeXMediaImageUrl(img.currentSrc || img.src || img.getAttribute('src') || ''))
		.filter(Boolean));
}

function extractXMediaImagesFromHtml(content: string): string[] {
	const doc = new DOMParser().parseFromString(content, 'text/html');
	const fromDom = extractXMediaImagesFromElement(doc.body);
	const fromSource = Array.from(content.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))
		.map(match => normalizeXMediaImageUrl(match[1]))
		.filter(Boolean);
	return dedupePreserveOrder([...fromDom, ...fromSource]);
}

function normalizeXMediaImagesInElement(element: Element): string[] {
	const normalizedImages: string[] = [];
	element.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
		const src = img.currentSrc || img.src || img.getAttribute('src') || '';
		const imageUrl = normalizeXMediaImageUrl(src);
		if (!imageUrl) return;
		img.setAttribute('src', imageUrl);
		img.removeAttribute('srcset');
		img.setAttribute('alt', img.getAttribute('alt') || 'Image');
		normalizedImages.push(imageUrl);
	});
	return dedupePreserveOrder(normalizedImages);
}

function buildXImageFigure(imageUrl: string): string {
	return `<figure><img src="${escapeHtml(imageUrl)}" alt="Image"></figure>`;
}

function getXLinePreservingText(element: HTMLElement | null): string {
	if (!element) return '';
	const innerText = element.innerText || '';
	const textContent = element.textContent || '';
	const innerTextLineCount = innerText.split(/\r\n?|\n/).length;
	const textContentLineCount = textContent.split(/\r\n?|\n/).length;
	return textContentLineCount > innerTextLineCount ? textContent : innerText;
}

function buildXTextHtmlFromPlainText(text: string): string {
	const normalizedLines = text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map(line => line.trimEnd());
	for (let index = 0; index < normalizedLines.length - 1; index++) {
		if (/^@Image$/i.test(normalizedLines[index].trim()) && /^\d+\b/.test(normalizedLines[index + 1].trim())) {
			normalizedLines[index] = `${normalizedLines[index].trim()}${normalizedLines[index + 1].trim()}`;
			normalizedLines.splice(index + 1, 1);
		}
	}
	while (normalizedLines.length > 0 && !normalizedLines[0].trim()) normalizedLines.shift();
	while (normalizedLines.length > 0 && !normalizedLines[normalizedLines.length - 1].trim()) normalizedLines.pop();

	const blocks: string[] = [];
	let currentBlock: string[] = [];
	const flushBlock = () => {
		if (currentBlock.length === 0) return;
		blocks.push(`<p>${currentBlock.map(line => escapeHtml(line)).join('<br>')}</p>`);
		currentBlock = [];
	};

	for (const line of normalizedLines) {
		if (!line.trim()) {
			flushBlock();
			continue;
		}
		currentBlock.push(line);
	}
	flushBlock();

	return blocks.join('');
}

function collectXMediaImagesOutsideBody(article: HTMLElement, bodyRoot: Element | null, beforeBody: boolean): string[] {
	if (!bodyRoot) return [];
	return dedupePreserveOrder(Array.from(article.querySelectorAll<HTMLImageElement>('img'))
		.filter(img => !bodyRoot.contains(img))
		.filter(img => {
			const position = img.compareDocumentPosition(bodyRoot);
			const isBeforeBody = !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
			return beforeBody ? isBeforeBody : !isBeforeBody;
		})
		.map(img => normalizeXMediaImageUrl(img.currentSrc || img.src || img.getAttribute('src') || ''))
		.filter(Boolean));
}

function buildXArticleStructuredHtml(article: HTMLElement, pageUrl: string): string {
	const longform = article.querySelector<HTMLElement>('[data-testid="longformRichTextComponent"]');
	const tweetText = article.querySelector<HTMLElement>('[data-testid="tweetText"]');
	const body = (longform || tweetText)?.cloneNode(true) as HTMLElement | null;
	const bodyText = getXLinePreservingText(longform || tweetText);
	if (body) {
		body.querySelectorAll('button, [role="button"], svg, [aria-hidden="true"]').forEach(el => el.remove());
		body.querySelectorAll<HTMLElement>('[style]').forEach(el => el.removeAttribute('style'));
		normalizeXMediaImagesInElement(body);
	}

	const mediaImages = extractXMediaImagesFromElement(article);
	const includedImages = new Set(body ? extractXMediaImagesFromElement(body) : []);
	const beforeBodyImages = collectXMediaImagesOutsideBody(article, longform || tweetText, true)
		.filter(imageUrl => !includedImages.has(imageUrl));
	for (const imageUrl of beforeBodyImages) includedImages.add(imageUrl);
	const afterBodyImages = collectXMediaImagesOutsideBody(article, longform || tweetText, false)
		.filter(imageUrl => !includedImages.has(imageUrl));
	for (const imageUrl of afterBodyImages) includedImages.add(imageUrl);
	const fallbackImages = mediaImages.filter(imageUrl => !includedImages.has(imageUrl));

	const parts = ['<article class="x-structured-article">'];
	for (const imageUrl of beforeBodyImages) {
		parts.push(buildXImageFigure(imageUrl));
	}
	if (bodyText.trim()) parts.push(buildXTextHtmlFromPlainText(bodyText));
	for (const imageUrl of [...afterBodyImages, ...fallbackImages]) {
		parts.push(buildXImageFigure(imageUrl));
	}
	parts.push('</article>');
	return parts.join('');
}

export async function extractXStructuredContent(doc: Document, pageUrl: string): Promise<PlatformStructuredContent | null> {
	if (!isXStatusUrl(pageUrl)) return null;
	if (xThreadSnapshot?.pageUrl === normalizeXStatusUrl(pageUrl)) {
		const candidate = hasXVideoMedia(doc) ? await extractXVideoCandidate(pageUrl) : null;
		const content = candidate && !xThreadSnapshot.content.includes(candidate.url)
			? xThreadSnapshot.content.replace('</article>', `${buildXVideoSection(candidate)}</article>`)
			: xThreadSnapshot.content;
		return {
			author: xThreadSnapshot.author,
			content,
			image: xThreadSnapshot.image,
			published: xThreadSnapshot.published,
			site: 'X',
			title: xThreadSnapshot.title,
			wordCount: xThreadSnapshot.wordCount,
		};
	}

	const article = getXTargetArticle(doc, pageUrl);
	if (!article) return null;

	const hasLongform = !!article.querySelector('[data-testid="longformRichTextComponent"]');
	const mediaImages = extractXMediaImagesFromElement(article);
	const hasVideo = hasXVideoMedia(article);
	const hasTweetText = !!article.querySelector('[data-testid="tweetText"]');
	if (!hasLongform && !hasTweetText && mediaImages.length === 0 && !hasVideo) return null;

	const title = extractXArticleTitle(article, pageUrl);
	const time = article.querySelector<HTMLTimeElement>('time[datetime]');
	let content = buildXArticleStructuredHtml(article, pageUrl);
	const candidate = hasVideo ? await extractXVideoCandidate(pageUrl) : null;
	if (candidate && !content.includes(candidate.url)) {
		content = content.replace('</article>', `${buildXVideoSection(candidate)}</article>`);
	}
	return {
		author: getXStatusAuthor(pageUrl) || '',
		content,
		image: mediaImages[0] || '',
		published: time?.dateTime || '',
		site: 'X',
		title,
		wordCount: (article.innerText || '').split(/\s+/).filter(Boolean).length,
	};
}

export async function extractXVideoCandidate(url: string): Promise<XVideoCandidate | null> {
	const tweetId = getTweetId(url);
	if (!tweetId) return null;

	const localCandidate = chooseBestCandidate([
		...extractFromInitialState(tweetId),
		...extractFromDom(),
		...extractFromPerformance(),
	]);
	if (localCandidate) return localCandidate;

	return extractFromMainWorld(url);
}

export async function appendXVideoFallback(content: string, pageUrl: string, doc?: Document): Promise<string> {
	const hasVideoMedia = doc ? hasXVideoMedia(doc) : /<video\b|data-obsidian-clipper-x-video/i.test(content);
	const candidate = hasVideoMedia ? await extractXVideoCandidate(pageUrl) : null;
	const contentWithBlobFallbacks = replaceXBlobVideos(content, pageUrl, candidate);
	if (contentWithBlobFallbacks !== content) return contentWithBlobFallbacks;
	let nextContent = content;
	if (candidate && !nextContent.includes(candidate.url)) {
		nextContent = insertXVideoSectionNearTweetMedia(nextContent, buildXVideoSection(candidate), pageUrl);
	}

	if (!hasVideoMedia) return nextContent;

	for (const threadUrl of collectThreadStatusUrls(content, pageUrl, doc).slice(0, 3)) {
		if (threadUrl === pageUrl) continue;
		const threadCandidate = await extractXVideoCandidate(threadUrl);
		if (!threadCandidate || nextContent.includes(threadCandidate.url)) continue;
		nextContent = insertXVideoSectionNearTweetMedia(nextContent, buildXVideoSection(threadCandidate), threadUrl);
	}

	if (nextContent !== content) {
		console.log('[X Clipper] Added video fallback:', {
			pageUrl,
		});
	}

	return nextContent;
}

export async function buildXMarkdownWithMedia(content: string, pageUrl: string): Promise<PlatformMarkdownResult | null> {
	if (!isXStatusUrl(pageUrl)) return null;

	const markdownBody = createMarkdownContent(content, pageUrl);
	const mediaImages = extractXMediaImagesFromHtml(content);
	const missingImages = mediaImages.filter((imageUrl) => {
		const escapedUrl = imageUrl.replace(/&/g, '&amp;');
		return !markdownBody.includes(imageUrl) && !markdownBody.includes(escapedUrl);
	});
	if (missingImages.length === 0) {
		return {
			content,
			markdownBody,
			debugInfo: {
				xMediaImageCount: mediaImages.length,
				xMissingMediaImageCount: 0,
				xImageInlineMode: 'remote-url',
			},
		};
	}

	const imageMarkdown = missingImages
		.map(imageUrl => `![Image](${imageUrl})`)
		.join('\n\n');
	return {
		content,
		markdownBody: `${markdownBody.trim()}\n\n${imageMarkdown}`.trim(),
		debugInfo: {
			xMediaImageCount: mediaImages.length,
			xMissingMediaImageCount: missingImages.length,
			xImageInlineMode: 'remote-url',
		},
	};
}

function collectThreadStatusUrls(content: string, pageUrl: string, doc?: Document): string[] {
	const sourceAuthor = getXStatusAuthor(pageUrl);
	const urls = Array.from(content.matchAll(/https:\/\/(?:x|twitter)\.com\/[^"'<>\s)]+\/status\/\d+/gi), match => {
		return normalizeXStatusUrl(match[0], pageUrl);
	}).filter(Boolean);

	const domUrls = doc
		? Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
			.map(anchor => normalizeXStatusUrl(anchor.getAttribute('href') || anchor.href, pageUrl))
			.filter(Boolean)
		: [];

	const ordered = [normalizeXStatusUrl(pageUrl), ...urls, ...domUrls].filter(Boolean);
	const sameAuthor = ordered.filter(url => getXStatusAuthor(url) === sourceAuthor);
	return Array.from(new Set(sameAuthor.length ? sameAuthor : ordered)).slice(0, 8);
}

function replaceXBlobVideos(content: string, pageUrl: string, candidate: XVideoCandidate | null): string {
	const videoPattern = /<video\b[\s\S]*?<\/video>/gi;
	let replacedCount = 0;
	const nextContent = content.replace(videoPattern, (block) => {
		if (!/blob:https?:\/\/(?:x|twitter)\.com/i.test(block)) return block;
		const poster = block.match(/\bposter=["']([^"']+)["']/i)?.[1];
		if (candidate?.url && !replacedCount) {
			replacedCount++;
			return buildXVideoSection(candidate);
		}
		if (!poster) return block;
		replacedCount++;
		return [
			'<section data-obsidian-clipper-x-video="true">',
			'<h2>X 视频</h2>',
			`<p><a href="${escapeHtml(pageUrl)}">X视频：打开原文播放</a></p>`,
			`<p><a href="${escapeHtml(pageUrl)}"><img src="${escapeHtml(poster)}" alt="X视频封面"></a></p>`,
			'</section>',
		].join('');
	});

	return replacedCount > 0 ? nextContent : content;
}

function buildXVideoSection(candidate: XVideoCandidate): string {
	const lines = [
		'<section data-obsidian-clipper-x-video="true">',
		'<h2>X 视频</h2>',
		`<video controls preload="metadata"${candidate.poster ? ` poster="${escapeHtml(candidate.poster)}"` : ''} src="${escapeHtml(candidate.url)}"></video>`,
		`<p><a href="${escapeHtml(candidate.url)}">X视频未内联：下载/打开视频</a></p>`,
	];
	if (candidate.poster) {
		lines.push(`<p><a href="${escapeHtml(candidate.url)}"><img src="${escapeHtml(candidate.poster)}" alt="X视频封面"></a></p>`);
	}
	lines.push('</section>');
	return lines.join('');
}

function insertXVideoSectionNearTweetMedia(content: string, videoSection: string, tweetUrl?: string): string {
	try {
		const parser = new DOMParser();
		const doc = parser.parseFromString(content, 'text/html');
		let target: Element | null = null;
		if (tweetUrl) {
			const exactLink = Array.from(doc.querySelectorAll('a[href]'))
				.find(link => link.getAttribute('href') === tweetUrl);
			const tweet = exactLink?.closest('.tweet');
			target = tweet?.querySelector('.tweet-text') || null;
		}
		target = target
			|| doc.querySelector('.main-tweet .tweet-text')
			|| doc.querySelector('.tweet-thread .tweet .tweet-text')
			|| doc.querySelector('[data-testid="tweetText"]');

		if (!target) return `${content}<hr>${videoSection}`;

		const template = doc.createElement('template');
		template.innerHTML = videoSection;
		const section = template.content.firstElementChild;
		if (!section) return `${content}<hr>${videoSection}`;

		target.insertAdjacentElement('afterend', section);
		return doc.body.innerHTML;
	} catch {
		return `${content}<hr>${videoSection}`;
	}
}
