export interface XiaohongshuNoteContent {
	noteId: string;
	title: string;
	author: string;
	description: string;
	tags: string[];
	images: string[];
	videoUrl: string;
	type: string;
	published: string;
	image: string;
	structuredHtml: string;
	wordCount: number;
}

interface XiaohongshuInitialState {
	note?: {
		noteDetailMap?: Record<string, {
			note?: XiaohongshuRawNote;
		}>;
	};
}

interface XiaohongshuRawNote {
	noteId?: string;
	title?: string;
	desc?: string;
	type?: string;
	time?: number;
	lastUpdateTime?: number;
	imageList?: Array<{
		urlDefault?: string;
		urlPre?: string;
		url?: string;
		infoList?: Array<{ url?: string }>;
	}>;
	tagList?: Array<{
		name?: string;
		type?: string;
	}>;
	user?: {
		nickname?: string;
		name?: string;
	};
	video?: {
		mediaV2?: string;
		media?: {
			stream?: Record<string, Array<{
				masterUrl?: string;
				master_url?: string;
				backupUrls?: string[];
				backup_urls?: string[];
			}>>;
		};
	};
}

const XIAOHONGSHU_HOST_PATTERN = /(^|\.)xiaohongshu\.com$/i;
const XHSLINK_HOST_PATTERN = /(^|\.)xhslink\.com$/i;

export function isXiaohongshuUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return XIAOHONGSHU_HOST_PATTERN.test(parsed.hostname)
			|| XHSLINK_HOST_PATTERN.test(parsed.hostname);
	} catch {
		return false;
	}
}

export function isXiaohongshuNoteUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (XHSLINK_HOST_PATTERN.test(parsed.hostname)) return true;
		if (!XIAOHONGSHU_HOST_PATTERN.test(parsed.hostname)) return false;
		return /^\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+/i.test(parsed.pathname);
	} catch {
		return false;
	}
}

export function normalizeXiaohongshuUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (XIAOHONGSHU_HOST_PATTERN.test(parsed.hostname)) {
			parsed.pathname = parsed.pathname.replace(/^\/explore\//i, '/discovery/item/');
			return parsed.href;
		}
	} catch {
		// Keep the original input if URL parsing fails.
	}
	return url;
}

export function extractXiaohongshuState(html: string): XiaohongshuInitialState | null {
	const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i);
	if (!stateMatch) return null;

	let jsonText = stateMatch[1].trim();
	jsonText = jsonText
		.replace(/;?\s*$/g, '')
		.replace(/\bundefined\b/g, 'null');

	try {
		return JSON.parse(jsonText) as XiaohongshuInitialState;
	} catch {
		return null;
	}
}

export function extractXiaohongshuNoteFromHtml(html: string, fallbackUrl = ''): XiaohongshuNoteContent | null {
	const state = extractXiaohongshuState(html);
	const noteDetailMap = state?.note?.noteDetailMap;
	if (!noteDetailMap) return null;

	const noteId = Object.keys(noteDetailMap)[0];
	const note = noteId ? noteDetailMap[noteId]?.note : null;
	if (!note) return null;

	const description = cleanXiaohongshuText(note.desc || '');
	const tags = extractXiaohongshuTags(note, description);
	const images = extractXiaohongshuImages(note);
	const videoUrl = extractXiaohongshuVideoUrl(note);
	const title = cleanXiaohongshuTitle(
		note.title
		|| readHtmlTitle(html)
		|| description.split('\n').find(Boolean)
		|| '小红书笔记'
	);
	const author = note.user?.nickname || note.user?.name || '';
	const published = formatXiaohongshuTime(note.time || note.lastUpdateTime);
	const structuredHtml = buildXiaohongshuStructuredHtml({
		title,
		description,
		tags,
		images,
		videoUrl,
		url: normalizeXiaohongshuUrl(fallbackUrl),
	});

	return {
		noteId: note.noteId || noteId,
		title,
		author,
		description,
		tags,
		images,
		videoUrl,
		type: note.type || (videoUrl ? 'video' : 'normal'),
		published,
		image: images[0] || '',
		structuredHtml,
		wordCount: countWords(`${title}\n${description}\n${tags.join(' ')}`),
	};
}

export function extractXiaohongshuNoteFromDocument(doc: Document, fallbackUrl = ''): XiaohongshuNoteContent | null {
	const container = doc.querySelector('#noteContainer, .note-detail-mask');
	if (!container) return null;

	const title = cleanXiaohongshuTitle(
		readTextContent(container, '#detail-title')
		|| doc.title
		|| '小红书笔记'
	);
	const descElement = container.querySelector('#detail-desc');
	const description = cleanXiaohongshuText(descElement?.textContent || '');
	const tags = uniqueStrings(
		Array.from(descElement?.querySelectorAll('a.tag, #hash-tag') || [])
			.map(el => (el.textContent || '').replace(/^#/, '').trim())
			.filter(Boolean)
	);
	const images = extractXiaohongshuImagesFromDom(container);
	const videoUrl = extractXiaohongshuVideoFromDom(container);
	const noteId = container.getAttribute('note-id') || parseXiaohongshuNoteId(fallbackUrl);
	const author = readTextContent(container, '.author-wrapper a.name')
		|| readTextContent(container, '.author-container a.name')
		|| readTextContent(container, 'a.name');
	const published = readTextContent(container, '.date, .bottom-container .date');
	const structuredHtml = buildXiaohongshuStructuredHtml({
		title,
		description,
		tags,
		images,
		videoUrl,
		url: normalizeXiaohongshuUrl(fallbackUrl),
	});

	if (!title && !description && !images.length && !videoUrl) return null;

	return {
		noteId,
		title,
		author,
		description,
		tags,
		images,
		videoUrl,
		type: container.getAttribute('data-type') || (videoUrl ? 'video' : 'normal'),
		published,
		image: images[0] || '',
		structuredHtml,
		wordCount: countWords(`${title}\n${description}\n${tags.join(' ')}`),
	};
}

export async function extractXiaohongshuStructuredContent(
	doc: Document,
	url: string,
	fetchHtml?: (url: string) => Promise<string>
): Promise<XiaohongshuNoteContent | null> {
	if (!isXiaohongshuNoteUrl(url)) return null;

	const localContent = extractXiaohongshuNoteFromHtml(doc.documentElement.outerHTML, url);
	if (localContent) return localContent;

	const domContent = extractXiaohongshuNoteFromDocument(doc, url);
	if (domContent) return domContent;

	const fetchedHtml = fetchHtml ? await fetchHtml(url).catch(() => '') : '';
	if (!fetchedHtml) return null;

	return extractXiaohongshuNoteFromHtml(fetchedHtml, url)
		|| extractXiaohongshuNoteFromFetchedHtml(fetchedHtml, url);
}

function extractXiaohongshuImages(note: XiaohongshuRawNote): string[] {
	const seen = new Set<string>();
	const images: string[] = [];
	for (const image of note.imageList || []) {
		const candidates = [
			image.urlDefault,
			image.urlPre,
			image.url,
			...(image.infoList || []).map(item => item.url),
		];
		const best = candidates.find(isHttpUrl);
		if (best && !seen.has(best)) {
			seen.add(best);
			images.push(best);
		}
	}
	return images;
}

function extractXiaohongshuVideoUrl(note: XiaohongshuRawNote): string {
	const streams = note.video?.media?.stream || parseXiaohongshuMediaV2Streams(note.video?.mediaV2);
	if (!streams) return '';

	const preferred = [
		...(streams.h264 || []),
		...(streams.h265 || []),
		...Object.values(streams).flat(),
	];

	for (const stream of preferred) {
		if (isHttpUrl(stream.masterUrl)) return stream.masterUrl;
		if (isHttpUrl(stream.master_url)) return stream.master_url;
		const backupUrl = stream.backupUrls?.find(isHttpUrl)
			|| stream.backup_urls?.find(isHttpUrl);
		if (backupUrl) return backupUrl;
	}

	return '';
}

function parseXiaohongshuMediaV2Streams(value: string | undefined): Record<string, Array<{
	masterUrl?: string;
	master_url?: string;
	backupUrls?: string[];
	backup_urls?: string[];
}>> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		return parsed?.stream || null;
	} catch {
		return null;
	}
}

function extractXiaohongshuNoteFromFetchedHtml(html: string, fallbackUrl: string): XiaohongshuNoteContent | null {
	if (typeof DOMParser === 'undefined') return null;
	const doc = new DOMParser().parseFromString(html, 'text/html');
	return extractXiaohongshuNoteFromDocument(doc, fallbackUrl);
}

function extractXiaohongshuImagesFromDom(container: Element): string[] {
	return uniqueStrings(
		Array.from(container.querySelectorAll('img'))
			.map(img => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src || img.getAttribute('src') || '')
			.filter(isUsefulXiaohongshuMediaUrl)
	);
}

function extractXiaohongshuVideoFromDom(container: Element): string {
	const video = container.querySelector('video[src], video source[src]') as HTMLVideoElement | HTMLSourceElement | null;
	const src = video?.getAttribute('src') || '';
	return isHttpUrl(src) ? src : '';
}

function extractXiaohongshuTags(note: XiaohongshuRawNote, description: string): string[] {
	const tags = [
		...(note.tagList || []).map(tag => tag.name || ''),
		...(description.match(/#[^\s#]+/g) || []).map(tag => tag.replace(/^#/, '')),
	];
	const seen = new Set<string>();
	return tags
		.map(tag => tag.replace(/\[话题\]/g, '').trim())
		.filter(tag => tag && !seen.has(tag) && seen.add(tag));
}

function buildXiaohongshuStructuredHtml(input: {
	title: string;
	description: string;
	tags: string[];
	images: string[];
	videoUrl: string;
	url: string;
}): string {
	const sections: string[] = ['<section class="xiaohongshu-structured-content">'];

	if (input.videoUrl) {
		sections.push('<section class="xiaohongshu-video">');
		sections.push(`<video controls preload="metadata" src="${escapeHtmlAttribute(input.videoUrl)}" style="display:block;max-width:100%;height:auto;width:100%;"></video>`);
		sections.push('</section>');
	}

	if (input.images.length) {
		sections.push('<section class="xiaohongshu-images">');
		input.images.forEach((image, index) => {
			const alt = index === 0 ? `${input.title} 封面` : `${input.title} 图片 ${index + 1}`;
			sections.push(`<p><img src="${escapeHtmlAttribute(image)}" alt="${escapeHtmlAttribute(alt)}" style="display:block;max-width:100%;height:auto;"></p>`);
		});
		sections.push('</section>');
	}

	if (input.description) {
		sections.push('<section class="xiaohongshu-description">');
		input.description.split(/\n+/).filter(Boolean).forEach((paragraph) => {
			sections.push(`<p>${escapeHtml(paragraph)}</p>`);
		});
		sections.push('</section>');
	}

	if (input.tags.length) {
		sections.push('<p>');
		sections.push(input.tags.map(tag => `<span>#${escapeHtml(tag)}</span>`).join(' '));
		sections.push('</p>');
	}

	if (input.url) {
		sections.push(`<p><a href="${escapeHtmlAttribute(input.url)}">打开小红书原文</a></p>`);
	}

	sections.push('</section>');
	return sections.join('');
}

function cleanXiaohongshuText(value: string): string {
	return value
		.replace(/\r\n?/g, '\n')
		.replace(/\[话题\]/g, '')
		.replace(/\[[^\]]+\]/g, '')
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.join('\n')
		.trim();
}

function cleanXiaohongshuTitle(value: string): string {
	return value
		.replace(/\s*-\s*小红书\s*$/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function readHtmlTitle(html: string): string {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? decodeHtmlEntities(match[1]) : '';
}

function parseXiaohongshuNoteId(url: string): string {
	try {
		const match = new URL(url).pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/);
		return match?.[1] || '';
	} catch {
		return '';
	}
}

function readTextContent(root: Element | Document, selector: string): string {
	return root.querySelector(selector)?.textContent?.trim() || '';
}

function formatXiaohongshuTime(value: number | undefined): string {
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

function isHttpUrl(value: string | undefined): value is string {
	return /^https?:\/\//i.test(value || '');
}

function isUsefulXiaohongshuMediaUrl(value: string): boolean {
	if (!isHttpUrl(value)) return false;
	if (/sns-avatar/i.test(value)) return false;
	if (/picasso-static/i.test(value)) return false;
	if (/avatar\//i.test(value)) return false;
	return /xhscdn\.com|xiaohongshu\.com/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter(value => value && !seen.has(value) && seen.add(value));
}

function decodeHtmlEntities(value: string): string {
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
