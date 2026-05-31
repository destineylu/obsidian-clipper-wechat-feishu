export interface DouyinAwemeContent {
	awemeId: string;
	title: string;
	author: string;
	description: string;
	images: string[];
	videoUrl: string;
	type: string;
	published: string;
	image: string;
	structuredHtml: string;
	wordCount: number;
}

interface DouyinRawAweme {
	aweme_id?: string;
	awemeId?: string;
	id?: string;
	item_id?: string;
	desc?: string;
	description?: string;
	create_time?: number;
	createTime?: number;
	author?: {
		nickname?: string;
		name?: string;
		unique_id?: string;
		uniqueId?: string;
	};
	video?: {
		cover?: DouyinUrlList;
		dynamic_cover?: DouyinUrlList;
		origin_cover?: DouyinUrlList;
		play_addr?: DouyinUrlList;
		playAddr?: DouyinUrlList;
		download_addr?: DouyinUrlList;
		downloadAddr?: DouyinUrlList;
		bit_rate?: Array<{
			bit_rate?: number;
			bitrate?: number;
			play_addr?: DouyinUrlList;
			playAddr?: DouyinUrlList;
		}>;
		bitRate?: Array<{
			bit_rate?: number;
			bitrate?: number;
			play_addr?: DouyinUrlList;
			playAddr?: DouyinUrlList;
		}>;
	};
	image_post_info?: {
		images?: DouyinRawImage[];
	};
	imagePostInfo?: {
		images?: DouyinRawImage[];
	};
	images?: DouyinRawImage[];
	statistics?: Record<string, unknown>;
}

interface DouyinRawImage {
	display_image?: DouyinUrlList;
	displayImage?: DouyinUrlList;
	origin_image?: DouyinUrlList;
	originImage?: DouyinUrlList;
	url_list?: string[];
	urlList?: string[];
	url?: string;
}

interface DouyinUrlList {
	url_list?: string[];
	urlList?: string[];
	url?: string;
	uri?: string;
}

const DOUYIN_HOST_PATTERN = /(^|\.)douyin\.com$/i;
const IES_DOUYIN_HOST_PATTERN = /(^|\.)iesdouyin\.com$/i;
const SHORT_DOUYIN_HOST_PATTERN = /(^|\.)v\.douyin\.com$/i;
const DOUYIN_MEDIA_HOST_PATTERN = /douyin|douyinvod|douyinpic|byteimg|bytecdn|pstatp|ixigua|snssdk|zjcdn/i;

export function isDouyinUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return DOUYIN_HOST_PATTERN.test(parsed.hostname)
			|| IES_DOUYIN_HOST_PATTERN.test(parsed.hostname)
			|| SHORT_DOUYIN_HOST_PATTERN.test(parsed.hostname);
	} catch {
		return false;
	}
}

export function isDouyinAwemeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (SHORT_DOUYIN_HOST_PATTERN.test(parsed.hostname)) return true;
		if (IES_DOUYIN_HOST_PATTERN.test(parsed.hostname)) {
			return /^\/share\/(?:video|note)\/\d+/i.test(parsed.pathname);
		}
		if (!DOUYIN_HOST_PATTERN.test(parsed.hostname)) return false;
		return /^\/(?:video|note)\/\d+/i.test(parsed.pathname)
			|| /^\/share\/(?:video|note)\/\d+/i.test(parsed.pathname);
	} catch {
		return false;
	}
}

export function normalizeDouyinUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const awemeId = parseDouyinAwemeId(url);
		if (awemeId && (DOUYIN_HOST_PATTERN.test(parsed.hostname) || IES_DOUYIN_HOST_PATTERN.test(parsed.hostname))) {
			return `https://www.douyin.com/video/${awemeId}`;
		}
	} catch {
		// Keep the original input if URL parsing fails.
	}
	return url;
}

export function extractDouyinAwemeFromHtml(html: string, fallbackUrl = ''): DouyinAwemeContent | null {
	const roots = extractDouyinJsonRoots(html);
	const awemeId = parseDouyinAwemeId(fallbackUrl);
	const aweme = chooseDouyinAweme(roots.flatMap(findDouyinAwemeObjects), awemeId);
	if (!aweme) return null;
	return buildDouyinContentFromAweme(aweme, html, fallbackUrl);
}

export function extractDouyinAwemeFromDocument(doc: Document, fallbackUrl = ''): DouyinAwemeContent | null {
	const stateContent = extractDouyinAwemeFromHtml(doc.documentElement.outerHTML, fallbackUrl);
	if (stateContent) return stateContent;

	const description = cleanDouyinText(
		readMetaContent(doc, 'meta[name="description"]')
		|| readMetaContent(doc, 'meta[property="og:description"]')
		|| readTextContent(doc, '[data-e2e="video-desc"], .video-info-detail, .title')
	);
	const title = cleanDouyinTitle(
		readMetaContent(doc, 'meta[property="og:title"]')
		|| doc.title
		|| description.split('\n').find(Boolean)
		|| '抖音作品'
	);
	const author = readMetaContent(doc, 'meta[name="author"]')
		|| readTextContent(doc, '[data-e2e="video-author-name"], .author-name');
	const images = extractDouyinImagesFromDom(doc);
	const videoUrl = extractDouyinVideoFromDom(doc);
	const awemeId = parseDouyinAwemeId(fallbackUrl);
	const structuredHtml = buildDouyinStructuredHtml({
		title,
		description,
		images,
		videoUrl,
		url: normalizeDouyinUrl(fallbackUrl),
	});

	if (!title && !description && !images.length && !videoUrl) return null;

	return {
		awemeId,
		title,
		author,
		description,
		images,
		videoUrl,
		type: images.length && !videoUrl ? 'image' : 'video',
		published: '',
		image: images[0] || '',
		structuredHtml,
		wordCount: countWords(`${title}\n${description}`),
	};
}

export async function extractDouyinStructuredContent(
	doc: Document,
	url: string,
	fetchHtml?: (url: string) => Promise<string>
): Promise<DouyinAwemeContent | null> {
	if (!isDouyinAwemeUrl(url)) return null;

	const localContent = extractDouyinAwemeFromHtml(doc.documentElement.outerHTML, url)
		|| extractDouyinAwemeFromDocument(doc, url);
	if (localContent) return localContent;

	const fetchedHtml = fetchHtml ? await fetchHtml(url).catch(() => '') : '';
	if (!fetchedHtml) return null;

	return extractDouyinAwemeFromHtml(fetchedHtml, url)
		|| extractDouyinAwemeFromFetchedHtml(fetchedHtml, url);
}

function extractDouyinJsonRoots(html: string): unknown[] {
	const roots: unknown[] = [];

	for (const json of extractScriptJsonAssignments(html, [
		'window._ROUTER_DATA',
		'_ROUTER_DATA',
		'window.__UNIVERSAL_DATA_FOR_REHYDRATION__',
		'__UNIVERSAL_DATA_FOR_REHYDRATION__',
	])) {
		roots.push(json);
	}

	for (const content of extractScriptTagContents(html, /id=["']RENDER_DATA["']/i)) {
		const decoded = decodePossiblyEncodedJson(content.trim());
		const parsed = parseJson(decoded);
		if (parsed) roots.push(parsed);
	}

	for (const content of extractScriptTagContents(html, /type=["']application\/ld\+json["']/i)) {
		const parsed = parseJson(content.trim());
		if (parsed) roots.push(parsed);
	}

	return roots;
}

function extractScriptJsonAssignments(html: string, markers: string[]): unknown[] {
	const roots: unknown[] = [];
	for (const marker of markers) {
		let searchFrom = 0;
		while (searchFrom < html.length) {
			const markerIndex = html.indexOf(marker, searchFrom);
			if (markerIndex < 0) break;
			const start = html.indexOf('{', markerIndex + marker.length);
			if (start < 0) break;
			const end = findJsonObjectEnd(html, start);
			if (end < 0) break;
			const parsed = parseJson(html.slice(start, end + 1));
			if (parsed) roots.push(parsed);
			searchFrom = end + 1;
		}
	}
	return roots;
}

function extractScriptTagContents(html: string, attributePattern: RegExp): string[] {
	const contents: string[] = [];
	for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
		if (!attributePattern.test(match[1])) continue;
		contents.push(decodeHtmlEntities(match[2] || ''));
	}
	return contents;
}

function findJsonObjectEnd(source: string, start: number): number {
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
			if (depth === 0) return index;
		}
	}

	return -1;
}

function parseJson(value: string): unknown | null {
	try {
		return JSON.parse(value.replace(/\bundefined\b/g, 'null'));
	} catch {
		return null;
	}
}

function decodePossiblyEncodedJson(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function findDouyinAwemeObjects(root: unknown): DouyinRawAweme[] {
	const found: DouyinRawAweme[] = [];
	const seen = new Set<unknown>();
	const stack: unknown[] = [root];

	while (stack.length) {
		const current = stack.pop();
		if (!isObject(current) || seen.has(current)) continue;
		seen.add(current);

		if (looksLikeDouyinAweme(current)) {
			found.push(current as DouyinRawAweme);
		}

		for (const value of Object.values(current)) {
			if (isObject(value) || Array.isArray(value)) {
				stack.push(value);
			}
		}
	}

	return found;
}

function looksLikeDouyinAweme(value: Record<string, unknown>): boolean {
	const id = readString(value.aweme_id || value.awemeId || value.item_id || value.id);
	const hasText = typeof value.desc === 'string' || typeof value.description === 'string';
	const hasMedia = isObject(value.video)
		|| isObject(value.image_post_info)
		|| isObject(value.imagePostInfo)
		|| Array.isArray(value.images);
	return !!id && (hasText || hasMedia) && (isObject(value.author) || hasMedia);
}

function chooseDouyinAweme(awemes: DouyinRawAweme[], expectedId: string): DouyinRawAweme | null {
	const unique = dedupeBy(awemes, aweme => getDouyinAwemeId(aweme));
	if (expectedId) {
		const exact = unique.find(aweme => getDouyinAwemeId(aweme) === expectedId);
		if (exact) return exact;
	}
	return unique.sort((left, right) => scoreDouyinAweme(right) - scoreDouyinAweme(left))[0] || null;
}

function scoreDouyinAweme(aweme: DouyinRawAweme): number {
	return (aweme.desc || aweme.description ? 3 : 0)
		+ (extractDouyinVideoUrl(aweme) ? 4 : 0)
		+ extractDouyinImages(aweme).length
		+ (aweme.author?.nickname || aweme.author?.name ? 2 : 0);
}

function buildDouyinContentFromAweme(aweme: DouyinRawAweme, html: string, fallbackUrl: string): DouyinAwemeContent {
	const awemeId = getDouyinAwemeId(aweme);
	const description = cleanDouyinText(aweme.desc || aweme.description || '');
	const images = extractDouyinImages(aweme);
	const videoUrl = extractDouyinVideoUrl(aweme);
	const title = cleanDouyinTitle(
		description.split('\n').find(Boolean)
		|| readHtmlTitle(html)
		|| '抖音作品'
	);
	const author = aweme.author?.nickname || aweme.author?.name || aweme.author?.unique_id || aweme.author?.uniqueId || '';
	const published = formatDouyinTime(aweme.create_time || aweme.createTime);
	const structuredHtml = buildDouyinStructuredHtml({
		title,
		description,
		images,
		videoUrl,
		url: normalizeDouyinUrl(fallbackUrl || (awemeId ? `https://www.douyin.com/video/${awemeId}` : '')),
	});

	return {
		awemeId,
		title,
		author,
		description,
		images,
		videoUrl,
		type: images.length && !videoUrl ? 'image' : 'video',
		published,
		image: images[0] || extractDouyinCover(aweme) || '',
		structuredHtml,
		wordCount: countWords(`${title}\n${description}`),
	};
}

function extractDouyinVideoUrl(aweme: DouyinRawAweme): string {
	const video = aweme.video;
	if (!video) return '';

	const bitRates = [
		...(video.bit_rate || []),
		...(video.bitRate || []),
	].sort((left, right) => (right.bit_rate || right.bitrate || 0) - (left.bit_rate || left.bitrate || 0));

	const candidates = [
		...bitRates.flatMap(rate => readUrlList(rate.play_addr || rate.playAddr)),
		...readUrlList(video.play_addr || video.playAddr),
		...readUrlList(video.download_addr || video.downloadAddr),
	];

	return normalizeDouyinMediaUrl(candidates.find(isUsefulDouyinVideoUrl) || '');
}

function extractDouyinCover(aweme: DouyinRawAweme): string {
	const video = aweme.video;
	if (!video) return '';
	return [
		...readUrlList(video.cover),
		...readUrlList(video.origin_cover),
		...readUrlList(video.dynamic_cover),
	].find(isUsefulDouyinImageUrl) || '';
}

function extractDouyinImages(aweme: DouyinRawAweme): string[] {
	const imagePostInfo = aweme.image_post_info || aweme.imagePostInfo;
	const images = [
		...(imagePostInfo?.images || []),
		...(aweme.images || []),
	];
	const urls = images.flatMap(image => [
		...readUrlList(image.origin_image || image.originImage),
		...readUrlList(image.display_image || image.displayImage),
		...(image.url_list || image.urlList || []),
		image.url || '',
	]);
	return uniqueStrings(urls.map(normalizeDouyinMediaUrl).filter(isUsefulDouyinImageUrl));
}

function readUrlList(value: DouyinUrlList | undefined): string[] {
	if (!value) return [];
	return [
		...(value.url_list || []),
		...(value.urlList || []),
		value.url || '',
		value.uri && isHttpUrl(value.uri) ? value.uri : '',
	].filter(Boolean);
}

function extractDouyinAwemeFromFetchedHtml(html: string, fallbackUrl: string): DouyinAwemeContent | null {
	if (typeof DOMParser === 'undefined') return null;
	const doc = new DOMParser().parseFromString(html, 'text/html');
	return extractDouyinAwemeFromDocument(doc, fallbackUrl);
}

function extractDouyinImagesFromDom(doc: Document): string[] {
	return uniqueStrings(
		Array.from(doc.querySelectorAll<HTMLImageElement>('img'))
			.map(img => img.currentSrc || img.src || img.getAttribute('src') || '')
			.map(normalizeDouyinMediaUrl)
			.filter(isUsefulDouyinImageUrl)
	);
}

function extractDouyinVideoFromDom(doc: Document): string {
	const video = doc.querySelector<HTMLVideoElement>('video[src], video source[src]');
	const src = video?.getAttribute('src') || '';
	return isUsefulDouyinVideoUrl(src) ? normalizeDouyinMediaUrl(src) : '';
}

function buildDouyinStructuredHtml(input: {
	title: string;
	description: string;
	images: string[];
	videoUrl: string;
	url: string;
}): string {
	const sections: string[] = ['<section class="douyin-structured-content">'];

	if (input.videoUrl) {
		sections.push('<section class="douyin-video">');
		sections.push(`<video controls preload="metadata" src="${escapeHtmlAttribute(input.videoUrl)}" style="display:block;max-width:100%;height:auto;width:100%;"></video>`);
		sections.push('</section>');
	}

	if (input.images.length) {
		sections.push('<section class="douyin-images">');
		input.images.forEach((image, index) => {
			const alt = index === 0 ? `${input.title} 封面` : `${input.title} 图片 ${index + 1}`;
			sections.push(`<p><img src="${escapeHtmlAttribute(image)}" alt="${escapeHtmlAttribute(alt)}" style="display:block;max-width:100%;height:auto;"></p>`);
		});
		sections.push('</section>');
	}

	if (input.description) {
		sections.push('<section class="douyin-description">');
		input.description.split(/\n+/).filter(Boolean).forEach((paragraph) => {
			sections.push(`<p>${escapeHtml(paragraph)}</p>`);
		});
		sections.push('</section>');
	}

	if (input.url) {
		sections.push(`<p><a href="${escapeHtmlAttribute(input.url)}">打开抖音原文</a></p>`);
	}

	sections.push('</section>');
	return sections.join('');
}

function normalizeDouyinMediaUrl(value: string): string {
	return decodeHtmlEntities(value || '')
		.replace(/\\u0026/g, '&')
		.replace(/&amp;/g, '&')
		.trim();
}

function cleanDouyinText(value: string): string {
	return decodeHtmlEntities(value)
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.join('\n')
		.trim();
}

function cleanDouyinTitle(value: string): string {
	return cleanDouyinText(value)
		.replace(/\s*-\s*抖音\s*$/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function readHtmlTitle(html: string): string {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? decodeHtmlEntities(match[1]) : '';
}

function parseDouyinAwemeId(url: string): string {
	try {
		const parsed = new URL(url);
		const match = parsed.pathname.match(/\/(?:video|note|share\/video|share\/note)\/(\d+)/i);
		return match?.[1] || '';
	} catch {
		return '';
	}
}

function getDouyinAwemeId(aweme: DouyinRawAweme): string {
	return readString(aweme.aweme_id || aweme.awemeId || aweme.item_id || aweme.id);
}

function readMetaContent(doc: Document, selector: string): string {
	return doc.querySelector<HTMLMetaElement>(selector)?.content?.trim() || '';
}

function readTextContent(root: Element | Document, selector: string): string {
	return root.querySelector(selector)?.textContent?.trim() || '';
}

function formatDouyinTime(value: number | undefined): string {
	if (!value) return '';
	const milliseconds = value > 10_000_000_000 ? value : value * 1000;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function countWords(value: string): number {
	const compact = value.replace(/\s+/g, '');
	if (/[\u4e00-\u9fff]/.test(compact)) return compact.length;
	return value.trim().split(/\s+/).filter(Boolean).length;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function readString(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function isHttpUrl(value: string | undefined): value is string {
	return /^https?:\/\//i.test(value || '');
}

function isUsefulDouyinVideoUrl(value: string): boolean {
	if (!isHttpUrl(value)) return false;
	if (/blob:/i.test(value)) return false;
	if (!DOUYIN_MEDIA_HOST_PATTERN.test(value)) return false;
	return /\.(?:mp4|m3u8)(?:[?#]|$)/i.test(value) || /playwm|play|video_id|mime_type=video/i.test(value);
}

function isUsefulDouyinImageUrl(value: string): boolean {
	if (!isHttpUrl(value)) return false;
	if (!DOUYIN_MEDIA_HOST_PATTERN.test(value)) return false;
	if (/avatar|logo|emoji|webcast|comment/i.test(value)) return false;
	return /\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(value) || /image|tos-cn|douyinpic/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter(value => value && !seen.has(value) && seen.add(value));
}

function dedupeBy<T>(values: T[], keyFn: (value: T) => string): T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = keyFn(value);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function decodeHtmlEntities(value: string): string {
	if (typeof document === 'undefined') {
		return value
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'");
	}
	const textarea = document.createElement('textarea');
	textarea.innerHTML = value;
	return textarea.value;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value: string): string {
	return escapeHtml(value).replace(/`/g, '&#96;');
}
