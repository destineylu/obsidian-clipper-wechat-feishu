import browser from '../../utils/browser-polyfill';
import { createMarkdownContent } from 'defuddle/full';
import { PlatformMarkdownResult, PlatformStructuredContent } from '../types';

interface XVideoVariant {
	bit_rate?: number;
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
	mediaCount: number;
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

interface XPageMediaSnapshot {
	imageUrls: string[];
	mediaLinks: string[];
	pageUrl: string;
}

const X_STATUS_PATTERN = /^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i;
const VIDEO_URL_PATTERN = /^https:\/\/video\.twimg\.com\/.+\.(?:mp4|m3u8)(?:[?#].*)?$/i;
const SHOW_MORE_PATTERN = /\bshow more\b|\bread more\b|显示更多|查看更多|展开全文|展开更多|查看全部/i;
const SHOW_MORE_EXCLUDE_PATTERN = /\bshow more repl(?:y|ies)\b|\breplies\b|\breply\b|\bcomments?\b|\bmore menu\b|回复|评论|更多菜单/i;
const X_MEDIA_IMAGE_PATTERN = /^https:\/\/pbs\.twimg\.com\/(?:media|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//i;
const X_VIDEO_FETCH_TIMEOUT_MS = 8000;
let xThreadSnapshot: XThreadSnapshot | null = null;
let xPageMediaSnapshot: XPageMediaSnapshot | null = null;

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
		if (/^\/media\//i.test(parsed.pathname) && parsed.searchParams.has('name')) {
			parsed.searchParams.set('name', 'large');
		}
		return parsed.href;
	} catch {
		return '';
	}
}

function normalizeXArticleMediaUrl(value: string, baseUrl: string): string {
	try {
		const parsed = new URL(decodeHtmlAttribute(value), baseUrl);
		if (!/^\/[^/]+\/article\/\d+\/media\/\d+$/i.test(parsed.pathname)) return '';
		return parsed.href;
	} catch {
		return '';
	}
}

function dedupePreserveOrder<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function countMatches(value: string, pattern: RegExp): number {
	return (value.match(pattern) || []).length;
}

function extractUrlsFromCssValue(value: string): string[] {
	return Array.from(value.matchAll(/url\((["']?)(.*?)\1\)/gi), match => match[2]).filter(Boolean);
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
			return (right.bitrate || right.bit_rate || 0) - (left.bitrate || left.bit_rate || 0);
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
	const mediaInfo = isObject(media.media_info) ? media.media_info : null;
	const videoInfo = isObject(media.video_info) ? media.video_info : mediaInfo;
	if (!isObject(videoInfo) || !Array.isArray(videoInfo.variants)) return null;

	const variant = chooseBestVariant(videoInfo.variants as XVideoVariant[]);
	if (!variant?.url) return null;

	const id = String(media.id_str || media.media_id || media.media_key || variant.url);
	const previewImage = isObject(mediaInfo?.preview_image) ? mediaInfo.preview_image : null;
	const poster = typeof media.media_url_https === 'string'
		? media.media_url_https
		: typeof media.media_url === 'string'
			? media.media_url
			: typeof previewImage?.original_img_url === 'string'
				? previewImage.original_img_url
				: undefined;

	return {
		id,
		poster,
		url: normalizeVideoUrl(variant.url),
		bitrate: variant.bitrate || variant.bit_rate,
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

async function extractFromMainWorldCandidates(url: string): Promise<XVideoCandidate[]> {
	const response = await Promise.race([
		browser.runtime.sendMessage({
			action: 'xExtractVideoCandidate',
			url,
		}).catch(() => null),
		wait(X_VIDEO_FETCH_TIMEOUT_MS).then(() => null),
	]) as { success?: boolean; candidate?: XVideoCandidate | null; candidates?: XVideoCandidate[] } | null;
	if (!response?.success) return [];
	return dedupeCandidates([
		...(Array.isArray(response.candidates) ? response.candidates : []),
		...(response.candidate ? [response.candidate] : []),
	]);
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
	return !!root.querySelector([
		'video',
		'[data-testid="videoPlayer"]',
		'[data-testid="videoComponent"]',
		'img[src*="amplify_video_thumb"]',
		'img[src*="ext_tw_video_thumb"]',
		'img[src*="tweet_video_thumb"]',
		'a[href*="/article/"][href*="/media/"]',
	].join(','));
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
		const mediaCount = countXStructuredMediaItems(snapshot.html);
		if (!existing
			|| snapshot.text.length > existing.text.length + 20
			|| mediaCount > existing.mediaCount) {
			articlesByUrl.set(statusUrl, {
				html: snapshot.html,
				mediaCount,
				statusUrl: snapshot.statusUrl,
				text: snapshot.text,
			});
		}
	}
}

function countXStructuredMediaItems(html: string): number {
	return countMatches(html, /https:\/\/pbs\.twimg\.com\/(?:media|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//gi)
		+ countMatches(html, /\/article\/\d+\/media\/\d+/gi);
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

function captureXPageMediaSnapshot(doc: Document, pageUrl: string): void {
	const article = getXTargetArticle(doc, pageUrl);
	if (!article) return;
	const nextSnapshot: XPageMediaSnapshot = {
		imageUrls: extractXMediaImagesFromElement(article),
		mediaLinks: collectXArticleMediaLinks(article, pageUrl),
		pageUrl: normalizeXStatusUrl(pageUrl),
	};
	if (!xPageMediaSnapshot || xPageMediaSnapshot.pageUrl !== nextSnapshot.pageUrl) {
		xPageMediaSnapshot = nextSnapshot;
		return;
	}
	xPageMediaSnapshot = {
		...nextSnapshot,
		imageUrls: dedupePreserveOrder([...xPageMediaSnapshot.imageUrls, ...nextSnapshot.imageUrls]),
		mediaLinks: dedupePreserveOrder([...xPageMediaSnapshot.mediaLinks, ...nextSnapshot.mediaLinks]),
	};
}

export async function hydrateXMediaBeforeExtract(doc: Document): Promise<void> {
	const win = doc.defaultView;
	const pageUrl = doc.URL || win?.location.href || '';
	if (!win || !isXStatusUrl(pageUrl)) return;
	if (!doc.querySelector('[data-testid="longformRichTextComponent"], article, video')) return;
	xThreadSnapshot = null;
	xPageMediaSnapshot = null;

	const startedAt = Date.now();
	const maxDurationMs = 8000;
	const hasTimeBudget = () => Date.now() - startedAt < maxDurationMs;
	const threadArticles = new Map<string, XThreadArticleSnapshot>();
	const threadState = { started: false, seenNonAuthor: false };
	const originalY = win.scrollY;
	let hasLongform = false;
	try {
		captureXPageMediaSnapshot(doc, pageUrl);
		collectVisibleXThreadArticles(doc, pageUrl, threadArticles, threadState);
		await expandXPrimaryShowMore(doc);
		if (hasTimeBudget()) await expandXThreadShowMore(doc, pageUrl);
		captureXPageMediaSnapshot(doc, pageUrl);
		collectVisibleXThreadArticles(doc, pageUrl, threadArticles, threadState);
		hasLongform = !!doc.querySelector('[data-testid="longformRichTextComponent"]');
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
		captureXPageMediaSnapshot(doc, pageUrl);
		collectVisibleXThreadArticles(doc, pageUrl, threadArticles, threadState);
		if (hasLongform) {
			xThreadSnapshot = null;
		} else {
			saveXThreadSnapshot(pageUrl, threadArticles);
		}
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
	const imageSources = Array.from(element.querySelectorAll<HTMLImageElement>('img'))
		.map(img => normalizeXMediaImageUrl(img.currentSrc || img.src || img.getAttribute('src') || ''))
		.filter(Boolean);
	const backgroundSources = Array.from(element.querySelectorAll<HTMLElement>('*'))
		.flatMap((node) => {
			const inlineStyle = node.getAttribute('style') || '';
			const computedStyle = typeof getComputedStyle === 'function' ? getComputedStyle(node).backgroundImage : '';
			return [
				...extractUrlsFromCssValue(inlineStyle),
				...extractUrlsFromCssValue(computedStyle),
			];
		})
		.map(src => normalizeXMediaImageUrl(src))
		.filter(Boolean);
	return dedupePreserveOrder([...imageSources, ...backgroundSources]);
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

function buildXImageFigure(imageUrl: string, linkUrl = ''): string {
	const image = `<img src="${escapeHtml(imageUrl)}" alt="Image">`;
	return linkUrl
		? `<figure><a href="${escapeHtml(linkUrl)}">${image}</a></figure>`
		: `<figure>${image}</figure>`;
}

function isXVideoThumbnailUrl(imageUrl: string): boolean {
	return /^https:\/\/pbs\.twimg\.com\/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//i.test(imageUrl);
}

function buildXVideoPosterFallback(imageUrl: string, pageUrl: string): string {
	return [
		'<section data-obsidian-clipper-x-video="true">',
		'<h2>X 视频</h2>',
		`<p><a href="${escapeHtml(pageUrl)}"><img src="${escapeHtml(imageUrl)}" alt="X视频封面"></a></p>`,
		`<p><a href="${escapeHtml(pageUrl)}">X视频：打开原文播放</a></p>`,
		'</section>',
	].join('');
}

function buildXMediaLink(mediaUrl: string): string {
	return `<p><a href="${escapeHtml(mediaUrl)}">X媒体：打开原文媒体</a></p>`;
}

function findXArticleCardLinkForImage(img: HTMLImageElement, pageUrl: string): string {
	if (!/article cover image/i.test(img.getAttribute('alt') || '')
		&& !img.closest('[data-testid="article-cover-image"]')) {
		return '';
	}
	const currentUrl = normalizeXStatusUrl(pageUrl);
	let node: Element | null = img.closest('[data-testid="article-cover-image"]') || img.parentElement;
	for (let depth = 0; node && depth < 8 && node.tagName !== 'ARTICLE'; depth++, node = node.parentElement) {
		const statusUrl = Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
			.map(anchor => normalizeXStatusUrl(anchor.getAttribute('href') || anchor.href, pageUrl))
			.find(url => url && url !== currentUrl);
		if (statusUrl) return statusUrl;
	}
	return '';
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

function collectXArticleMediaLinks(article: HTMLElement, pageUrl: string): string[] {
	return dedupePreserveOrder(Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/article/"][href*="/media/"]'))
		.filter(anchor => extractXMediaImagesFromElement(anchor).length === 0)
		.map(anchor => normalizeXArticleMediaUrl(anchor.getAttribute('href') || anchor.href, pageUrl))
		.filter(Boolean));
}

function getXCodeBlockLanguage(pre: HTMLElement): string {
	const code = pre.querySelector<HTMLElement>('code[class*="language-"]');
	const language = code?.className.match(/\blanguage-([\w-]+)/)?.[1] || '';
	return language.toLowerCase();
}

function buildXCodeBlock(pre: HTMLElement): string {
	const code = pre.querySelector<HTMLElement>('code') || pre;
	const language = getXCodeBlockLanguage(pre);
	return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.innerText || code.textContent || '')}</code></pre>`;
}

function stripTrailingXCodeLanguageLabel(text: string, language: string): string {
	if (!language) return text;
	const aliases = language === 'bash' ? ['bash', 'shell', 'sh', 'zsh'] : [language];
	const escapedAliases = aliases.map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return text.replace(new RegExp(`(?:\\s|\\n)*(?:${escapedAliases})\\s*$`, 'i'), '');
}

function collectXOrderedBodyMedia(bodyRoot: HTMLElement, pageUrl: string): Array<{ element: Element; html: string; imageUrl?: string; mediaUrl?: string; codeLanguage?: string }> {
	const ordered: Array<{ element: Element; html: string; imageUrl?: string; mediaUrl?: string; codeLanguage?: string }> = [];
	const seen = new Set<string>();
	for (const element of Array.from(bodyRoot.querySelectorAll<HTMLElement>('pre, a[href*="/article/"][href*="/media/"], img'))) {
		if (element.tagName !== 'PRE' && element.closest('pre')) continue;
		if (element instanceof HTMLAnchorElement && extractXMediaImagesFromElement(element).length > 0) continue;
		const isCodeBlock = element.tagName === 'PRE';
		const codeLanguage = isCodeBlock
			? getXCodeBlockLanguage(element)
			: '';
		const mediaUrl = element instanceof HTMLAnchorElement
			? normalizeXArticleMediaUrl(element.getAttribute('href') || element.href, pageUrl)
			: '';
		const imageUrl = element instanceof HTMLImageElement
			? normalizeXMediaImageUrl(element.currentSrc || element.src || element.getAttribute('src') || '')
			: '';
		const imageLinkUrl = element instanceof HTMLImageElement
			? findXArticleCardLinkForImage(element, pageUrl)
			: '';
		const key = isCodeBlock ? `code:${ordered.length}` : mediaUrl || imageUrl;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		ordered.push({
			element,
			html: isCodeBlock
				? buildXCodeBlock(element)
				: mediaUrl
				? buildXMediaLink(mediaUrl)
				: isXVideoThumbnailUrl(imageUrl)
					? buildXVideoPosterFallback(imageUrl, pageUrl)
					: buildXImageFigure(imageUrl, imageLinkUrl),
			imageUrl: imageUrl || undefined,
			mediaUrl: mediaUrl || undefined,
			codeLanguage: codeLanguage || undefined,
		});
	}
	return ordered;
}

function buildXBodyHtmlWithInlineMedia(
	bodyRoot: HTMLElement,
	pageUrl: string
): { html: string; imageUrls: string[]; mediaLinks: string[] } {
	const mediaItems = collectXOrderedBodyMedia(bodyRoot, pageUrl);
	if (mediaItems.length === 0) {
		return {
			html: buildXTextHtmlFromPlainText(getXLinePreservingText(bodyRoot)),
			imageUrls: [],
			mediaLinks: [],
		};
	}

	const doc = bodyRoot.ownerDocument;
	const parts: string[] = [];
	const imageUrls: string[] = [];
	const mediaLinks: string[] = [];
	const appendTextRange = (range: Range, nextCodeLanguage = '') => {
		const text = stripTrailingXCodeLanguageLabel(range.toString(), nextCodeLanguage);
		if (text.trim()) parts.push(buildXTextHtmlFromPlainText(text));
	};

	let startContainer: Node = bodyRoot;
	let startOffset = 0;
	for (const item of mediaItems) {
		const range = doc.createRange();
		range.setStart(startContainer, startOffset);
		range.setEndBefore(item.element);
		appendTextRange(range, item.codeLanguage || '');
		range.detach();

		parts.push(item.html);
		if (item.imageUrl) imageUrls.push(item.imageUrl);
		if (item.mediaUrl) mediaLinks.push(item.mediaUrl);

		startContainer = item.element.parentNode || bodyRoot;
		startOffset = Array.prototype.indexOf.call(startContainer.childNodes, item.element) + 1;
	}

	const tailRange = doc.createRange();
	tailRange.setStart(startContainer, startOffset);
	tailRange.setEnd(bodyRoot, bodyRoot.childNodes.length);
	appendTextRange(tailRange);
	tailRange.detach();

	return {
		html: parts.join(''),
		imageUrls: dedupePreserveOrder(imageUrls),
		mediaLinks: dedupePreserveOrder(mediaLinks),
	};
}

function buildXArticleStructuredHtml(article: HTMLElement, pageUrl: string): string {
	const longform = article.querySelector<HTMLElement>('[data-testid="longformRichTextComponent"]');
	const tweetText = article.querySelector<HTMLElement>('[data-testid="tweetText"]');
	const bodyRoot = longform || tweetText;
	const body = bodyRoot?.cloneNode(true) as HTMLElement | null;
	const bodyWithMedia = bodyRoot
		? buildXBodyHtmlWithInlineMedia(bodyRoot, pageUrl)
		: { html: '', imageUrls: [], mediaLinks: [] };
	if (body) {
		body.querySelectorAll('button, [role="button"], svg, [aria-hidden="true"]').forEach(el => el.remove());
		body.querySelectorAll<HTMLElement>('[style]').forEach(el => el.removeAttribute('style'));
		normalizeXMediaImagesInElement(body);
	}

	const mediaImages = extractXMediaImagesFromElement(article);
	const includedImages = new Set(body ? extractXMediaImagesFromElement(body) : []);
	const beforeBodyImages = collectXMediaImagesOutsideBody(article, bodyRoot, true)
		.filter(imageUrl => !includedImages.has(imageUrl));
	for (const imageUrl of beforeBodyImages) includedImages.add(imageUrl);
	const afterBodyImages = collectXMediaImagesOutsideBody(article, bodyRoot, false)
		.filter(imageUrl => !includedImages.has(imageUrl));
	for (const imageUrl of afterBodyImages) includedImages.add(imageUrl);
	for (const imageUrl of bodyWithMedia.imageUrls) includedImages.add(imageUrl);
	const fallbackImages = mediaImages.filter(imageUrl => !includedImages.has(imageUrl));
	const includedMediaLinks = new Set(bodyWithMedia.mediaLinks);
	const mediaLinks = collectXArticleMediaLinks(article, pageUrl)
		.filter(mediaUrl => !includedMediaLinks.has(mediaUrl));

	const parts = ['<article class="x-structured-article">'];
	for (const imageUrl of beforeBodyImages) {
		parts.push(buildXImageFigure(imageUrl));
	}
	if (bodyWithMedia.html) parts.push(bodyWithMedia.html);
	for (const imageUrl of [...afterBodyImages, ...fallbackImages]) {
		parts.push(buildXImageFigure(imageUrl));
	}
	for (const mediaUrl of mediaLinks) {
		parts.push(buildXMediaLink(mediaUrl));
	}
	parts.push('</article>');
	return parts.join('');
}

function addMissingXPageMedia(content: string, pageUrl: string): string {
	if (xPageMediaSnapshot?.pageUrl !== normalizeXStatusUrl(pageUrl)) return content;
	const existingImages = new Set(extractXMediaImagesFromHtml(content));
	const existingLinks = new Set(Array.from(content.matchAll(/https:\/\/x\.com\/[^"'<>\s)]+\/article\/\d+\/media\/\d+/gi), match => match[0]));
	const missingImages = xPageMediaSnapshot.imageUrls.filter(imageUrl => !existingImages.has(imageUrl));
	const missingLinks = xPageMediaSnapshot.mediaLinks.filter(mediaUrl => !existingLinks.has(mediaUrl));
	if (missingImages.length === 0 && missingLinks.length === 0) return content;
	const additions = [
		...missingImages.map(imageUrl => buildXImageFigure(imageUrl)),
		...missingLinks.map(buildXMediaLink),
	].join('');
	return content.includes('</article>')
		? content.replace('</article>', `${additions}</article>`)
		: `${content}${additions}`;
}

export async function extractXStructuredContent(doc: Document, pageUrl: string): Promise<PlatformStructuredContent | null> {
	if (!isXStatusUrl(pageUrl)) return null;
	if (xThreadSnapshot?.pageUrl === normalizeXStatusUrl(pageUrl)) {
		const candidates = hasXVideoMedia(doc) ? await extractXVideoCandidates(pageUrl) : [];
		const contentWithMedia = addMissingXPageMedia(xThreadSnapshot.content, pageUrl);
		const content = insertXVideoSections(contentWithMedia, candidates, pageUrl);
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
	content = addMissingXPageMedia(content, pageUrl);
	const candidates = hasVideo ? await extractXVideoCandidates(pageUrl) : [];
	content = insertXVideoSections(content, candidates, pageUrl);
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
	return chooseBestCandidate(await extractXVideoCandidates(url));
}

async function extractXVideoCandidates(url: string): Promise<XVideoCandidate[]> {
	const tweetId = getTweetId(url);
	if (!tweetId) return [];

	const localCandidates = dedupeCandidates([
		...extractFromInitialState(tweetId),
		...extractFromDom(),
		...extractFromPerformance(),
	]);

	const mainWorldCandidates = await extractFromMainWorldCandidates(url);
	return dedupeCandidates([...localCandidates, ...mainWorldCandidates]);
}

export async function appendXVideoFallback(content: string, pageUrl: string, doc?: Document): Promise<string> {
	const hasVideoMedia = doc ? hasXVideoMedia(doc) : /<video\b|data-obsidian-clipper-x-video/i.test(content);
	const candidates = hasVideoMedia ? await extractXVideoCandidates(pageUrl) : [];
	const candidate = chooseBestCandidate(candidates);
	const contentWithBlobFallbacks = replaceXBlobVideos(content, pageUrl, candidate);
	if (contentWithBlobFallbacks !== content) return contentWithBlobFallbacks;
	let nextContent = insertXVideoSections(content, candidates, pageUrl);

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

function insertXVideoSections(content: string, candidates: XVideoCandidate[], tweetUrl?: string): string {
	return dedupeCandidates(candidates).reduce((nextContent, candidate) => {
		if (!candidate.url || nextContent.includes(candidate.url)) return nextContent;
		return insertXVideoSectionNearTweetMedia(nextContent, buildXVideoSection(candidate), tweetUrl, candidate);
	}, content);
}

function extractXVideoSectionPosterUrl(videoSection: string): string {
	const poster = videoSection.match(/\bposter=["']([^"']+)["']/i)?.[1]
		|| videoSection.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1]
		|| '';
	return normalizeXMediaImageUrl(poster);
}

function findXVideoPosterTarget(doc: Document, posterUrl: string): Element | null {
	if (!posterUrl) return null;
	for (const image of Array.from(doc.querySelectorAll<HTMLImageElement>('img[src]'))) {
		const imageUrl = normalizeXMediaImageUrl(image.getAttribute('src') || image.src || '');
		if (imageUrl !== posterUrl) continue;
		const fallbackSection = image.closest('[data-obsidian-clipper-x-video]');
		if (fallbackSection) return fallbackSection;
		return image.closest('figure, p, section') || image;
	}
	return null;
}

function findXVideoMediaLinkTarget(doc: Document, candidate?: XVideoCandidate): Element | null {
	if (!candidate?.id) return null;
	const escapedId = candidate.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const mediaIdPattern = new RegExp(`/media/${escapedId}(?:["'/?#\\s]|$)`, 'i');
	for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
		const href = link.getAttribute('href') || link.href || '';
		if (!mediaIdPattern.test(href)) continue;
		return link.closest('p, figure, section') || link;
	}
	return null;
}

function findXVideoCueTarget(doc: Document): Element | null {
	const cuePattern = /先看成品|看成品|成品如下|效果如下|效果：|效果:|视频如下|👇/i;
	return Array.from(doc.querySelectorAll('p'))
		.find((paragraph) => cuePattern.test(paragraph.textContent || '')) || null;
}

function insertXVideoSectionNearTweetMedia(
	content: string,
	videoSection: string,
	tweetUrl?: string,
	candidate?: XVideoCandidate
): string {
	try {
		const parser = new DOMParser();
		const doc = parser.parseFromString(content, 'text/html');
		const template = doc.createElement('template');
		template.innerHTML = videoSection;
		const section = template.content.firstElementChild;
		if (!section) return `${content}<hr>${videoSection}`;

		const posterTarget = findXVideoPosterTarget(doc, extractXVideoSectionPosterUrl(videoSection));
		if (posterTarget) {
			posterTarget.replaceWith(section);
			return doc.body.innerHTML;
		}

		const mediaLinkTarget = findXVideoMediaLinkTarget(doc, candidate);
		if (mediaLinkTarget) {
			mediaLinkTarget.replaceWith(section);
			return doc.body.innerHTML;
		}

		let target: Element | null = findXVideoCueTarget(doc);
		if (tweetUrl) {
			const exactLink = Array.from(doc.querySelectorAll('a[href]'))
				.find(link => link.getAttribute('href') === tweetUrl);
			const tweet = exactLink?.closest('.tweet');
			target = target || tweet?.querySelector('.tweet-text') || null;
		}
		target = target
			|| doc.querySelector('.main-tweet .tweet-text')
			|| doc.querySelector('.tweet-thread .tweet .tweet-text')
			|| doc.querySelector('[data-testid="tweetText"]');

		if (!target) return `${content}<hr>${videoSection}`;

		target.insertAdjacentElement('afterend', section);
		return doc.body.innerHTML;
	} catch {
		return `${content}<hr>${videoSection}`;
	}
}
