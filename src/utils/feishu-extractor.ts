import browser from './browser-polyfill';
import { processUrls } from './string-utils';
import { debugLog } from './debug';
import {
	renderFeishuBitableResource,
	renderFeishuSheetResource,
	renderUnsupportedFeishuResource,
} from './feishu-resource-renderer';
import {
	fetchBitableResourcePreview,
	fetchSheetResourcePreview,
	getFeishuResourceErrorReason,
	parseEmbeddedBitableToken,
	parseEmbeddedSheetToken,
	withoutTopLevelResourceHeading,
} from './feishu-resource-adapters';

export interface FeishuParsedUrl {
	type: 'wiki' | 'docx' | 'doc' | 'sheet' | 'bitable' | null;
	token: string | null;
}

export interface FeishuStructuredContent {
	title: string;
	author: string;
	content: string;
	wordCount: number;
}

interface FeishuTextElement {
	content?: string;
	text_element_style?: {
		bold?: boolean;
		italic?: boolean;
		strikethrough?: boolean;
		underline?: boolean;
		inline_code?: boolean;
		link?: { url?: string };
	};
}

interface FeishuTextRun {
	content?: string;
	text_element_style?: FeishuTextElement['text_element_style'];
}

interface FeishuMentionUser {
	user_id?: string;
	text_element_style?: FeishuTextElement['text_element_style'];
}

interface FeishuTextBody {
	elements?: Array<{
		text_run?: FeishuTextRun;
		mention_user?: FeishuMentionUser;
		mention_doc?: { token?: string; title?: string; obj_type?: number; text_element_style?: FeishuTextElement['text_element_style'] };
		equation?: { content?: string };
	}>;
	style?: {
		align?: number;
		list?: {
			type?: string;
			indentLevel?: number;
			number?: number;
		};
		quote?: boolean;
	};
}

interface FeishuFileBlock {
	name?: string;
	token?: string;
	mime_type?: string;
	type?: string;
}

interface FeishuEmbedBlock {
	url?: string;
	href?: string;
	src?: string;
	title?: string;
	name?: string;
}

interface FeishuTokenBlock {
	token?: string;
}

interface FeishuBlock {
	block_id: string;
	parent_id?: string;
	children?: string[];
	block_type: number;
	page?: { elements?: FeishuTextBody['elements']; style?: FeishuTextBody['style'] };
	text?: FeishuTextBody;
	heading1?: FeishuTextBody;
	heading2?: FeishuTextBody;
	heading3?: FeishuTextBody;
	heading4?: FeishuTextBody;
	heading5?: FeishuTextBody;
	heading6?: FeishuTextBody;
	heading7?: FeishuTextBody;
	heading8?: FeishuTextBody;
	heading9?: FeishuTextBody;
	bullet?: FeishuTextBody;
	ordered?: FeishuTextBody;
	code?: FeishuTextBody & { style?: FeishuTextBody['style'] & { language?: number; wrap?: boolean } };
	quote?: FeishuTextBody;
	todo?: FeishuTextBody & { style?: FeishuTextBody['style'] & { done?: boolean } };
	callout?: FeishuTextBody & { style?: FeishuTextBody['style'] & { background_color?: number; emoji_id?: string } };
	quote_container?: object;
	divider?: object;
	image?: { width?: number; height?: number; token?: string; title?: string };
	table?: { cells?: string[]; property?: { row_size?: number; column_size?: number; merge_info?: Array<{ row_span?: number; col_span?: number }> } };
	table_cell?: object;
	grid?: { column_size?: number };
	grid_column?: object;
	file?: FeishuFileBlock;
	iframe?: FeishuEmbedBlock;
	widget?: FeishuEmbedBlock;
	chat_card?: FeishuEmbedBlock;
	bitable?: FeishuTokenBlock;
	sheet?: FeishuTokenBlock;
	task?: { task_id?: string };
	okr?: { okr_id?: string; objectives?: Array<{ objective_id?: string; kr_ids?: string[] }> };
	okr_objective?: { content?: FeishuTextBody };
	okr_key_result?: { content?: FeishuTextBody };
	okr_progress?: object;
	view?: object;
	undefined_block?: object;
}

interface FeishuDomVideo {
	src: string;
	poster?: string;
}

interface FeishuDomMedia {
	images: string[];
	imageUrlsByToken: Map<string, string>;
	videos: FeishuDomVideo[];
	embeds: string[];
}

interface FeishuRenderContext {
	documentUrl: string;
	openApiHost: string;
	objType: string;
	domMedia: FeishuDomMedia;
	resourcePreviewCache: Map<string, Promise<string>>;
}

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_INLINE_MEDIA_BYTES = 128 * 1024 * 1024;
const FEISHU_MEDIA_FETCH_TIMEOUT_MS = 8_000;
const FEISHU_MEDIA_CALLER_GRACE_MS = 1_000;
const DEFAULT_FEISHU_MEDIA_INLINE_CONCURRENCY = 4;

interface FeishuFetchedMedia {
	dataUrl: string;
	size: number;
}

function redactFeishuIdentifier(value: string | null | undefined): string {
	return value ? `[redacted:${value.length}]` : '[none]';
}

function redactFeishuUrl(value: string): string {
	try {
		const parsed = new URL(value);
		const type = parsed.pathname.match(/^\/(wiki|docx|docs?|sheets|base)(?:\/|$)/)?.[1] || 'api';
		return `https://<feishu-host>/${type}/<redacted>`;
	} catch {
		return '[invalid-url]';
	}
}

const FEISHU_BLOCK_TYPE = {
	PAGE: 1,
	TEXT: 2,
	HEADING1: 3,
	HEADING2: 4,
	HEADING3: 5,
	HEADING4: 6,
	HEADING5: 7,
	HEADING6: 8,
	HEADING7: 9,
	HEADING8: 10,
	HEADING9: 11,
	BULLET: 12,
	ORDERED: 13,
	CODE: 14,
	QUOTE: 15,
	TODO: 17,
	BITABLE: 18,
	CALLOUT: 19,
	CHAT_CARD: 20,
	DIAGRAM: 21,
	DIVIDER: 22,
	FILE: 23,
	GRID: 24,
	GRID_COLUMN: 25,
	IFRAME: 26,
	IMAGE: 27,
	WIDGET: 28,
	MINDNOTE: 29,
	SHEET: 30,
	TABLE: 31,
	TABLE_CELL: 32,
	VIEW: 33,
	QUOTE_CONTAINER: 34,
	TASK: 35,
	OKR: 36,
	OKR_OBJECTIVE: 37,
	OKR_KEY_RESULT: 38,
	OKR_PROGRESS: 39,
} as const;

export function isFeishuDocUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const isFeishuHost = parsed.hostname.endsWith('.feishu.cn') || parsed.hostname.endsWith('.larksuite.com');
		if (!isFeishuHost) return false;
		return /^\/(wiki|docx|docs?|sheets|base)\/[\w-]+/.test(parsed.pathname);
	} catch {
		return false;
	}
}

export function isAllowedFeishuDirectMediaUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== 'https:') return false;
		if (parsedUrl.hostname === 'internal-api-drive-stream.feishu.cn') {
			return parsedUrl.pathname.startsWith('/space/api/box/stream/download/');
		}
		return /^s\d+-imfile\.feishucdn\.com$/i.test(parsedUrl.hostname);
	} catch {
		return false;
	}
}

function rejectedFeishuDirectMediaHostname(url: string): string | null {
	try {
		const parsedUrl = new URL(url);
		const hostname = parsedUrl.hostname.toLowerCase();
		if (
			hostname === 'open.feishu.cn' ||
			hostname === 'open.larksuite.com'
		) {
			return null;
		}
		const isFeishuOrLarkHost =
			hostname.endsWith('.feishu.cn') ||
			hostname.endsWith('.feishucdn.com') ||
			hostname.endsWith('.larksuite.com') ||
			hostname.endsWith('.larksuitecdn.com');
		if (!isFeishuOrLarkHost) return null;
		return /(?:imfile|drive|stream|media|file|cdn)/i.test(
			`${hostname}${parsedUrl.pathname}`
		)
			? hostname
			: null;
	} catch {
		return null;
	}
}

export function parseFeishuUrl(url: string): FeishuParsedUrl {
	try {
		const parsed = new URL(url);
		const match = parsed.pathname.match(/^\/(wiki|docx|docs?|sheets|base)\/([\w-]+)/);
		if (!match) return { type: null, token: null };
		const rawType = match[1];
		const normalizedType = (
			rawType === 'docs'
				? 'doc'
				: rawType === 'sheets'
					? 'sheet'
					: rawType === 'base'
						? 'bitable'
						: rawType
		) as Exclude<FeishuParsedUrl['type'], null>;
		return {
			type: normalizedType,
			token: match[2],
		};
	} catch {
		return { type: null, token: null };
	}
}

async function fetchFeishuApi(url: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<any> {
	const response = await browser.runtime.sendMessage({
		action: 'fetchFeishuApi',
		url,
		options,
	}) as { success?: boolean; data?: any; error?: string };

	if (!response?.success) {
		const errMsg = response?.error || 'Failed to fetch Feishu API';
		debugLog('Feishu', 'API request failed', {
			error: errMsg,
			url: redactFeishuUrl(url),
		});
		throw new Error(errMsg);
	}
	return response.data;
}

export async function fetchFeishuMediaAsDataUrl(
	url: string,
	maxBytes = MAX_INLINE_IMAGE_BYTES,
	timeoutMs = FEISHU_MEDIA_FETCH_TIMEOUT_MS
): Promise<FeishuFetchedMedia> {
	const requestId = crypto.randomUUID();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let callerTimedOut = false;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			callerTimedOut = true;
			void browser.runtime.sendMessage({
				action: 'cancelFeishuMedia',
				requestId,
			}).catch(() => {});
			reject(new Error(`Feishu media fetch timed out after ${timeoutMs}ms`));
		}, timeoutMs + FEISHU_MEDIA_CALLER_GRACE_MS);
	});

	const response = await Promise.race([
		browser.runtime.sendMessage({
			action: 'fetchFeishuMedia',
			url,
			maxBytes,
			requestId,
			timeoutMs,
		}) as Promise<{ success?: boolean; data?: { dataUrl?: string; size?: number }; error?: string }>,
		timeoutPromise,
	]).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
		if (callerTimedOut) {
			void browser.runtime.sendMessage({
				action: 'cancelFeishuMedia',
				requestId,
			}).catch(() => {});
		}
	});

	if (!response?.success || !response.data?.dataUrl) {
		throw new Error(response?.error || 'Failed to fetch Feishu media');
	}

	return {
		dataUrl: response.data.dataUrl,
		size: typeof response.data.size === 'number'
			? response.data.size
			: Math.ceil(response.data.dataUrl.length * 3 / 4),
	};
}

async function resolveResource(parsedUrl: FeishuParsedUrl): Promise<{ resourceId: string; objType: string } | null> {
	if (!parsedUrl.token || !parsedUrl.type) return null;

	if (parsedUrl.type === 'wiki') {
		const result = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${parsedUrl.token}`
		);
		const node = result?.data?.node;
		if (!node?.obj_token) {
			debugLog('Feishu', 'Wiki get_node returned no obj_token', {
				code: result?.code,
				hasData: !!result?.data,
			});
			return null;
		}
		return { resourceId: node.obj_token, objType: node.obj_type || 'docx' };
	}

	return {
		resourceId: parsedUrl.token,
		objType: parsedUrl.type === 'doc' ? 'doc' : parsedUrl.type,
	};
}

async function fetchAllBlocks(documentId: string): Promise<FeishuBlock[]> {
	const allBlocks: FeishuBlock[] = [];
	let pageToken: string | undefined;

	do {
		const params = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
		if (pageToken) params.set('page_token', pageToken);

		const result = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks?${params.toString()}`
		);

		const items = result?.data?.items;
		if (Array.isArray(items)) {
			allBlocks.push(...items);
		}

		pageToken = result?.data?.has_more ? result.data.page_token : undefined;
	} while (pageToken);

	return allBlocks;
}

async function fetchDocumentMeta(documentId: string): Promise<{ title: string; owner?: string } | null> {
	try {
		const result = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}`
		);
		const doc = result?.data?.document;
		return doc ? { title: doc.title || '', owner: doc.owner_id } : null;
	} catch {
		return null;
	}
}

function renderTextElements(elements: FeishuTextBody['elements']): string {
	if (!elements || !elements.length) return '';

	return elements.map((el) => {
		if (el.equation?.content) {
			return `<code>${escapeHtml(el.equation.content)}</code>`;
		}

		if (el.mention_doc?.title) {
			return escapeHtml(el.mention_doc.title);
		}

		const run = el.text_run || el.mention_user;
		if (!run) return '';

		const text = el.text_run?.content ?? '';
		if (!text) return '';

		const style = run.text_element_style;
		let html = escapeHtml(text);

		if (style?.inline_code) {
			html = `<code>${html}</code>`;
		}
		if (style?.bold) {
			html = `<strong>${html}</strong>`;
		}
		if (style?.italic) {
			html = `<em>${html}</em>`;
		}
		if (style?.strikethrough) {
			html = `<s>${html}</s>`;
		}
		if (style?.underline) {
			html = `<u>${html}</u>`;
		}
		if (style?.link?.url) {
			try {
				const decoded = decodeURIComponent(style.link.url);
				html = `<a href="${escapeAttr(decoded)}">${html}</a>`;
			} catch {
				html = `<a href="${escapeAttr(style.link.url)}">${html}</a>`;
			}
		}

		return html;
	}).join('');
}

function getTextBody(block: FeishuBlock): FeishuTextBody | undefined {
	switch (block.block_type) {
		case FEISHU_BLOCK_TYPE.TEXT: return block.text;
		case FEISHU_BLOCK_TYPE.HEADING1: return block.heading1;
		case FEISHU_BLOCK_TYPE.HEADING2: return block.heading2;
		case FEISHU_BLOCK_TYPE.HEADING3: return block.heading3;
		case FEISHU_BLOCK_TYPE.HEADING4: return block.heading4;
		case FEISHU_BLOCK_TYPE.HEADING5: return block.heading5;
		case FEISHU_BLOCK_TYPE.HEADING6: return block.heading6;
		case FEISHU_BLOCK_TYPE.HEADING7: return block.heading7;
		case FEISHU_BLOCK_TYPE.HEADING8: return block.heading8;
		case FEISHU_BLOCK_TYPE.HEADING9: return block.heading9;
		case FEISHU_BLOCK_TYPE.BULLET: return block.bullet;
		case FEISHU_BLOCK_TYPE.ORDERED: return block.ordered;
		case FEISHU_BLOCK_TYPE.CODE: return block.code;
		case FEISHU_BLOCK_TYPE.QUOTE: return block.quote;
		case FEISHU_BLOCK_TYPE.TODO: return block.todo;
		case FEISHU_BLOCK_TYPE.CALLOUT: return block.callout;
		case FEISHU_BLOCK_TYPE.OKR_OBJECTIVE: return block.okr_objective?.content;
		case FEISHU_BLOCK_TYPE.OKR_KEY_RESULT: return block.okr_key_result?.content;
		default: return undefined;
	}
}

function getFeishuOpenApiHost(url: string): string {
	return url.includes('.larksuite.com/') || url.includes('.larksuite.com?') || url.includes('.larksuite.com#') || url.includes('://open.larksuite.com')
		? 'https://open.larksuite.com'
		: 'https://open.feishu.cn';
}

function getMediaParentTypes(objType: string, mediaKind: 'image' | 'file'): string[] {
	const isLegacyDoc = objType === 'doc';
	if (mediaKind === 'image') {
		return isLegacyDoc ? ['doc_image', 'docx_image'] : ['docx_image', 'doc_image'];
	}
	return isLegacyDoc ? ['doc_file', 'docx_file'] : ['docx_file', 'doc_file'];
}

function summarizeBlockTypes(blocks: FeishuBlock[]): Record<number, number> {
	return blocks.reduce<Record<number, number>>((summary, block) => {
		summary[block.block_type] = (summary[block.block_type] || 0) + 1;
		return summary;
	}, {});
}

function countMatches(value: string, pattern: RegExp): number {
	return value.match(pattern)?.length || 0;
}

function buildFeishuImagePlaceholder(token: string, fallbackUrl?: string): string {
	const placeholder = `feishu-image://${token}`;
	return fallbackUrl && isAllowedFeishuDirectMediaUrl(fallbackUrl)
		? `${placeholder}?fallback=${encodeURIComponent(fallbackUrl)}`
		: placeholder;
}

function buildFeishuFilePlaceholder(token: string): string {
	return `feishu-file://${token}`;
}

function describeMediaOrigin(src: string): 'data' | 'blob' | 'http' | 'unknown' {
	if (src.startsWith('data:')) return 'data';
	if (src.startsWith('blob:')) return 'blob';
	if (/^https?:/i.test(src)) return 'http';
	return 'unknown';
}

function buildFeishuMediaDownloadUrls(openApiHost: string, token: string, parentTypes: string[], mediaKind: 'image' | 'file'): string[] {
	const encodedToken = encodeURIComponent(token);
	const mediaUrls = [
		// Current Open Platform documentation uses the singular `media` route.
		`${openApiHost}/open-apis/drive/v1/media/${encodedToken}/download`,
		// Keep the legacy plural route for older Feishu deployments.
		...parentTypes.map(parentType => `${openApiHost}/open-apis/drive/v1/medias/${encodedToken}/download?parent_type=${encodeURIComponent(parentType)}`),
	];

	if (mediaKind === 'file') {
		return [
			...mediaUrls,
			// A document file block normally exposes a media token. This final
			// fallback only covers older blocks that expose a Drive file token.
			`${openApiHost}/open-apis/drive/v1/files/${encodedToken}/download`,
		];
	}

	return mediaUrls;
}

export function buildFeishuMediaDownloadLinks(pageUrl: string, token: string, mediaKind: 'image' | 'file'): string[] {
	const parsedUrl = parseFeishuUrl(pageUrl);
	const objType = parsedUrl.type === 'doc' ? 'doc' : 'docx';
	const openApiHost = getFeishuOpenApiHost(pageUrl);
	return buildFeishuMediaDownloadUrls(openApiHost, token, getMediaParentTypes(objType, mediaKind), mediaKind);
}

async function tryFetchFeishuMediaDataUrl(
	urls: string[],
	maxBytes: number,
	deadline: number | null,
	context?: { kind: 'image' | 'file'; token?: string; name?: string }
): Promise<FeishuFetchedMedia | null> {
	for (const url of urls) {
		const remainingMs = deadline === null
			? FEISHU_MEDIA_FETCH_TIMEOUT_MS
			: Math.max(0, deadline - Date.now());
		if (remainingMs <= 0) return null;
		try {
			return await fetchFeishuMediaAsDataUrl(
				url,
				maxBytes,
				Math.min(FEISHU_MEDIA_FETCH_TIMEOUT_MS, remainingMs)
			);
		} catch (error) {
			debugLog('Feishu', 'Media fetch candidate failed', {
				error: error instanceof Error ? error.message : String(error),
				url: redactFeishuUrl(url),
				kind: context?.kind,
				token: redactFeishuIdentifier(context?.token),
				name: context?.name,
				maxBytes,
			});
		}
	}
	return null;
}

function isLikelyVideoFile(name?: string, mimeType?: string): boolean {
	const lowerName = name?.toLowerCase() || '';
	const lowerMime = mimeType?.toLowerCase() || '';
	return lowerMime.startsWith('video/') || /\.(mp4|mov|m4v|webm|ogg|ogv|avi|mkv|wmv|3gp|m3u8)$/i.test(lowerName);
}

function isLikelyImageFile(name?: string, mimeType?: string): boolean {
	const lowerName = name?.toLowerCase() || '';
	const lowerMime = mimeType?.toLowerCase() || '';
	return lowerMime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lowerName);
}

function isSafeMediaUrl(url: string | null | undefined): url is string {
	if (!url) return false;
	return /^(https?:|data:|blob:|feishu-image:|feishu-file:)/i.test(url);
}

function extractVideoUrl(video: HTMLVideoElement): string | null {
	const source = video.currentSrc || video.src || video.querySelector('source')?.src || null;
	return isSafeMediaUrl(source) ? source : null;
}

function shouldKeepDomImage(img: HTMLImageElement): boolean {
	const src = img.currentSrc || img.src;
	if (!isSafeMediaUrl(src)) return false;
	if (/^data:image\/svg/i.test(src)) return false;
	if (/^(chrome|moz|safari)-extension:/i.test(src)) return false;
	if (img.closest('button, [role="button"], [aria-hidden="true"]')) return false;

	const width = img.naturalWidth || img.width || 0;
	const height = img.naturalHeight || img.height || 0;
	if (width && height && width < 48 && height < 48) return false;

	return true;
}

export function collectFeishuDirectMediaUrlsByToken(
	resourceUrls: Iterable<string>
): Map<string, string> {
	const urlsByToken = new Map<string, string>();
	const rejectedHostnames = new Set<string>();
	let rejectedResourceCount = 0;
	for (const resourceUrl of resourceUrls) {
		if (!isAllowedFeishuDirectMediaUrl(resourceUrl)) {
			const hostname = rejectedFeishuDirectMediaHostname(resourceUrl);
			if (hostname) {
				rejectedHostnames.add(hostname);
				rejectedResourceCount += 1;
			}
			continue;
		}
		try {
			const parsedUrl = new URL(resourceUrl);
			const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
			const encodedToken = pathSegments[pathSegments.length - 1];
			if (!encodedToken) continue;
			const token = decodeURIComponent(encodedToken);
			if (!token || /[\u0000-\u001f]/.test(token)) continue;
			urlsByToken.set(token, resourceUrl);
		} catch {
			// Ignore malformed or unsupported resource entries.
		}
	}
	if (rejectedHostnames.size > 0) {
		debugLog('Feishu', 'Rejected direct media hosts outside allowlist', {
			hostnames: [...rejectedHostnames].sort(),
			rejectedResourceCount,
		});
	}
	return urlsByToken;
}

function getFeishuPerformanceResourceUrls(doc: Document): string[] {
	try {
		const performanceApi = doc.defaultView?.performance;
		if (!performanceApi?.getEntriesByType) return [];
		return performanceApi
			.getEntriesByType('resource')
			.map(entry => entry.name)
			.filter((name): name is string => typeof name === 'string');
	} catch {
		return [];
	}
}

function collectFeishuDomMedia(doc: Document): FeishuDomMedia {
	const images = Array.from(doc.querySelectorAll('img'))
		.filter(shouldKeepDomImage)
		.map(img => img.currentSrc || img.src)
		.filter(isSafeMediaUrl);
	const imageUrlsByToken = collectFeishuDirectMediaUrlsByToken(
		getFeishuPerformanceResourceUrls(doc)
	);

	for (const tokenElement of Array.from(doc.querySelectorAll('[image-token]'))) {
		const token = tokenElement.getAttribute('image-token');
		if (!token || imageUrlsByToken.has(token)) continue;
		const imageBlock = tokenElement.closest('.docx-image-block') || tokenElement;
		const image = imageBlock.querySelector('img');
		const imageUrl = image?.currentSrc || image?.src || '';
		if (isAllowedFeishuDirectMediaUrl(imageUrl)) {
			imageUrlsByToken.set(token, imageUrl);
		}
	}

	const videos: FeishuDomVideo[] = Array.from(doc.querySelectorAll('video'))
		.flatMap(video => {
			const src = extractVideoUrl(video);
			if (!src) return [];
			const poster = isSafeMediaUrl(video.poster) ? video.poster : undefined;
			return [{ src, poster }];
		});

	const embeds = Array.from(doc.querySelectorAll('iframe'))
		.map(iframe => iframe.src)
		.filter(isSafeMediaUrl);

	return {
		images: dedupePreserveOrder(images),
		imageUrlsByToken,
		videos: dedupePreserveOrder(videos, video => `${video.src}::${video.poster || ''}`),
		embeds: dedupePreserveOrder(embeds),
	};
}

function dedupePreserveOrder<T>(items: T[], getKey: (item: T) => string = item => String(item)): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const item of items) {
		const key = getKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}


function buildImageHtml(src: string, options: { alt?: string; width?: number; height?: number }): string {
	const attrs = [`src="${escapeAttr(src)}"`, `alt="${escapeAttr(options.alt || '')}"`];
	if (options.width) attrs.push(`width="${options.width}"`);
	if (options.height) attrs.push(`height="${options.height}"`);
	return `<figure><img ${attrs.join(' ')}></figure>`;
}

function buildVideoHtml(src: string, options: { title?: string; poster?: string }): string {
	const attrs = [`controls`, `preload="metadata"`, `src="${escapeAttr(src)}"`];
	if (options.poster) {
		attrs.push(`poster="${escapeAttr(options.poster)}"`);
	}
	const caption = options.title ? `<figcaption>${escapeHtml(options.title)}</figcaption>` : '';
	return `<figure><video ${attrs.join(' ')}></video>${caption}</figure>`;
}

function resolveImageSource(block: FeishuBlock, context: FeishuRenderContext): string | null {
	const token = block.image?.token;
	if (token) {
		const fallbackUrl = context.domMedia.imageUrlsByToken.get(token);
		const placeholder = buildFeishuImagePlaceholder(token, fallbackUrl);
		debugLog('Feishu', 'Resolved image block to placeholder', {
			blockType: block.block_type,
			token: redactFeishuIdentifier(token),
			hasPageFallback: !!fallbackUrl,
			title: block.image?.title,
			width: block.image?.width,
			height: block.image?.height,
		});
		return placeholder;
	}

	const domCandidate = context.domMedia.images.shift() || null;
	if (!domCandidate) return null;

	debugLog('Feishu', 'Resolved image block from DOM URL', {
		blockType: block.block_type,
		token: redactFeishuIdentifier(token),
		origin: describeMediaOrigin(domCandidate),
	});
	return domCandidate;
}

function resolveVideoSource(file: FeishuFileBlock | undefined, context: FeishuRenderContext): { src: string; poster?: string } | null {
	const token = file?.token;
	if (token) {
		const placeholder = buildFeishuFilePlaceholder(token);
		debugLog('Feishu', 'Resolved video/file block to placeholder', {
			token: redactFeishuIdentifier(token),
			name: file?.name,
			mimeType: file?.mime_type,
		});
		return { src: placeholder };
	}

	const domCandidate = context.domMedia.videos.shift() || null;
	if (domCandidate) {
		debugLog('Feishu', 'Resolved video from DOM URL', {
			token: redactFeishuIdentifier(file?.token),
			name: file?.name,
			origin: describeMediaOrigin(domCandidate.src),
			hasPoster: !!domCandidate.poster,
		});
		return domCandidate;
	}

	return null;
}

function extractEmbedUrl(block: FeishuBlock): string | null {
	const candidates = [
		block.iframe?.url,
		block.iframe?.href,
		block.iframe?.src,
		block.widget?.url,
		block.widget?.href,
		block.widget?.src,
		block.chat_card?.url,
		block.chat_card?.href,
		block.chat_card?.src,
	];
	return candidates.find(isSafeMediaUrl) || null;
}

function renderUnsupportedBlock(
	block: FeishuBlock,
	context: FeishuRenderContext,
	label = '飞书复杂对象',
	reason = '当前对象无法完整转换'
): string {
	debugLog('Feishu', 'Rendered unsupported block fallback', {
		blockType: block.block_type,
		documentUrl: redactFeishuUrl(context.documentUrl),
		reason,
	});
	return [
		'<blockquote class="feishu-unsupported-block">',
		`<p><strong>${escapeHtml(label)}</strong>：${escapeHtml(reason)}。</p>`,
		`<p><a href="${escapeAttr(context.documentUrl)}">在飞书中打开此对象</a></p>`,
		'</blockquote>',
	].join('');
}

function renderEmbedBlock(block: FeishuBlock, context: FeishuRenderContext): string {
	const embedUrl = extractEmbedUrl(block) || context.domMedia.embeds.shift() || null;
	const title = block.iframe?.title || block.widget?.title || block.chat_card?.title || block.iframe?.name || block.widget?.name || block.chat_card?.name || 'Open embedded content';
	if (!embedUrl) {
		return renderUnsupportedBlock(block, context, title, '未提供可独立访问的嵌入地址');
	}
	if (/\.(mp4|mov|m4v|webm|ogg|ogv)(\?|#|$)/i.test(embedUrl)) {
		return buildVideoHtml(embedUrl, { title });
	}
	if (/^https?:/i.test(embedUrl)) {
		return `<figure><iframe src="${escapeAttr(embedUrl)}" loading="lazy" allowfullscreen></iframe><figcaption><a href="${escapeAttr(embedUrl)}">${escapeHtml(title)}</a></figcaption></figure>`;
	}
	return renderUnsupportedBlock(block, context, title, '嵌入地址格式不受支持');
}

function renderEmbeddedSheetBlock(block: FeishuBlock, context: FeishuRenderContext): Promise<string> {
	const token = block.sheet?.token?.trim();
	if (!token) {
		return Promise.resolve(renderUnsupportedBlock(block, context, '飞书电子表格', '块中没有可用的电子表格标识'));
	}
	const parsed = parseEmbeddedSheetToken(token);
	const cacheKey = `sheet:${parsed.spreadsheetToken}:${parsed.sheetId || ''}`;
	const cached = context.resourcePreviewCache.get(cacheKey);
	if (cached) return cached;

	const preview = fetchSheetResourcePreview(
		fetchFeishuApi,
		parsed.spreadsheetToken,
		context.documentUrl,
		'',
		parsed.sheetId
	)
		.then(resource => withoutTopLevelResourceHeading(
			renderFeishuSheetResource(
				resource.title,
				context.documentUrl,
				resource.sheets,
				resource.omittedSheetCount
			).content
		))
		.catch(error => renderUnsupportedBlock(
			block,
			context,
			'飞书电子表格',
			getFeishuResourceErrorReason(error)
		));
	context.resourcePreviewCache.set(cacheKey, preview);
	return preview;
}

function renderEmbeddedBitableBlock(block: FeishuBlock, context: FeishuRenderContext): Promise<string> {
	const token = block.bitable?.token?.trim();
	if (!token) {
		return Promise.resolve(renderUnsupportedBlock(block, context, '飞书多维表格', '块中没有可用的多维表格标识'));
	}
	const parsed = parseEmbeddedBitableToken(token);
	const cacheKey = `bitable:${parsed.appToken}:${parsed.tableId || ''}`;
	const cached = context.resourcePreviewCache.get(cacheKey);
	if (cached) return cached;

	const preview = fetchBitableResourcePreview(
		fetchFeishuApi,
		parsed.appToken,
		context.documentUrl,
		'',
		parsed.tableId
	)
		.then(resource => withoutTopLevelResourceHeading(
			renderFeishuBitableResource(
				resource.title,
				context.documentUrl,
				resource.tables,
				resource.omittedTableCount
			).content
		))
		.catch(error => renderUnsupportedBlock(
			block,
			context,
			'飞书多维表格',
			getFeishuResourceErrorReason(error)
		));
	context.resourcePreviewCache.set(cacheKey, preview);
	return preview;
}

async function convertBlocksToHtml(blocks: FeishuBlock[], context: FeishuRenderContext): Promise<string> {
	const blockMap = new Map<string, FeishuBlock>();
	for (const b of blocks) {
		blockMap.set(b.block_id, b);
	}

	const pageBlock = blocks.find(b => b.block_type === FEISHU_BLOCK_TYPE.PAGE);
	if (!pageBlock?.children?.length) {
		const rendered: string[] = [];
		for (const block of blocks.filter(b => b.block_type !== FEISHU_BLOCK_TYPE.PAGE)) {
			rendered.push(await renderBlock(block, blockMap, context));
		}
		return rendered.join('');
	}

	return renderChildren(pageBlock.children, blockMap, context);
}

async function renderChildren(childIds: string[], blockMap: Map<string, FeishuBlock>, context: FeishuRenderContext): Promise<string> {
	const parts: string[] = [];
	let i = 0;

	while (i < childIds.length) {
		const block = blockMap.get(childIds[i]);
		if (!block) {
			i++;
			continue;
		}

		if (block.block_type === FEISHU_BLOCK_TYPE.BULLET) {
			const listItems: string[] = [];
			while (i < childIds.length) {
				const current = blockMap.get(childIds[i]);
				if (!current || current.block_type !== FEISHU_BLOCK_TYPE.BULLET) break;
				listItems.push(await renderListItem(current, blockMap, context));
				i++;
			}
			parts.push(`<ul>${listItems.join('')}</ul>`);
			continue;
		}

		if (block.block_type === FEISHU_BLOCK_TYPE.ORDERED) {
			const listItems: string[] = [];
			while (i < childIds.length) {
				const current = blockMap.get(childIds[i]);
				if (!current || current.block_type !== FEISHU_BLOCK_TYPE.ORDERED) break;
				listItems.push(await renderListItem(current, blockMap, context));
				i++;
			}
			parts.push(`<ol>${listItems.join('')}</ol>`);
			continue;
		}

		if (block.block_type === FEISHU_BLOCK_TYPE.TODO) {
			const listItems: string[] = [];
			while (i < childIds.length) {
				const current = blockMap.get(childIds[i]);
				if (!current || current.block_type !== FEISHU_BLOCK_TYPE.TODO) break;
				const done = (current.todo as any)?.style?.done === true;
				const inner = renderTextElements(current.todo?.elements);
				const checkbox = done ? '[x] ' : '[ ] ';
				listItems.push(`<li>${escapeHtml(checkbox)}${inner}${await renderBlockChildren(current, blockMap, context)}</li>`);
				i++;
			}
			parts.push(`<ul class="feishu-todo">${listItems.join('')}</ul>`);
			continue;
		}

		parts.push(await renderBlock(block, blockMap, context));
		i++;
	}

	return parts.join('');
}

async function renderListItem(block: FeishuBlock, blockMap: Map<string, FeishuBlock>, context: FeishuRenderContext): Promise<string> {
	const body = getTextBody(block);
	const inner = renderTextElements(body?.elements);
	const children = await renderBlockChildren(block, blockMap, context);
	return `<li>${inner}${children}</li>`;
}

async function renderBlockChildren(block: FeishuBlock, blockMap: Map<string, FeishuBlock>, context: FeishuRenderContext): Promise<string> {
	if (!block.children?.length) return '';
	return renderChildren(block.children, blockMap, context);
}

async function renderFileBlock(block: FeishuBlock, context: FeishuRenderContext): Promise<string> {
	const file = block.file;
	const fileName = file?.name?.trim() || 'Open attachment';
	if (isLikelyVideoFile(file?.name, file?.mime_type)) {
		const video = await resolveVideoSource(file, context);
		if (video?.src) {
			debugLog('Feishu', 'Rendered file block as video', {
				blockType: block.block_type,
				token: redactFeishuIdentifier(file?.token),
				name: fileName,
				origin: describeMediaOrigin(video.src),
			});
			return buildVideoHtml(video.src, { title: fileName, poster: video.poster });
		}
	}

	if (isLikelyImageFile(file?.name, file?.mime_type) && file?.token) {
		const src = buildFeishuFilePlaceholder(file.token);
		debugLog('Feishu', 'Rendered file block as image placeholder', {
			blockType: block.block_type,
			token: redactFeishuIdentifier(file.token),
			name: fileName,
		});
		return buildImageHtml(src, { alt: fileName });
	}

	if (file?.token) {
		const placeholder = buildFeishuFilePlaceholder(file.token);
		debugLog('Feishu', 'Rendered file block as placeholder link', {
			blockType: block.block_type,
			token: redactFeishuIdentifier(file.token),
			name: fileName,
			placeholder: 'feishu-file://<redacted>',
		});
		return `<p><a href="${escapeAttr(placeholder)}">${escapeHtml(fileName)}</a></p>`;
	}

	debugLog('Feishu', 'Rendered file block as document fallback', {
		blockType: block.block_type,
		name: fileName,
		documentUrl: redactFeishuUrl(context.documentUrl),
	});
	return `<p><a href="${escapeAttr(context.documentUrl)}">${escapeHtml(fileName)}</a></p>`;
}

async function renderBlock(block: FeishuBlock, blockMap: Map<string, FeishuBlock>, context: FeishuRenderContext): Promise<string> {
	switch (block.block_type) {
		case FEISHU_BLOCK_TYPE.PAGE:
			return renderBlockChildren(block, blockMap, context);

		case FEISHU_BLOCK_TYPE.TEXT: {
			const inner = renderTextElements(block.text?.elements);
			if (!inner.trim()) return '';
			return `<p>${inner}</p>`;
		}

		case FEISHU_BLOCK_TYPE.HEADING1:
			return `<h1>${renderTextElements(block.heading1?.elements)}</h1>`;
		case FEISHU_BLOCK_TYPE.HEADING2:
			return `<h2>${renderTextElements(block.heading2?.elements)}</h2>`;
		case FEISHU_BLOCK_TYPE.HEADING3:
			return `<h3>${renderTextElements(block.heading3?.elements)}</h3>`;
		case FEISHU_BLOCK_TYPE.HEADING4:
			return `<h4>${renderTextElements(block.heading4?.elements)}</h4>`;
		case FEISHU_BLOCK_TYPE.HEADING5:
			return `<h5>${renderTextElements(block.heading5?.elements)}</h5>`;
		case FEISHU_BLOCK_TYPE.HEADING6:
			return `<h6>${renderTextElements(block.heading6?.elements)}</h6>`;
		case FEISHU_BLOCK_TYPE.HEADING7:
		case FEISHU_BLOCK_TYPE.HEADING8:
		case FEISHU_BLOCK_TYPE.HEADING9: {
			const body = getTextBody(block);
			return `<h6>${renderTextElements(body?.elements)}</h6>`;
		}

		case FEISHU_BLOCK_TYPE.BULLET:
			return `<ul>${await renderListItem(block, blockMap, context)}</ul>`;
		case FEISHU_BLOCK_TYPE.ORDERED:
			return `<ol>${await renderListItem(block, blockMap, context)}</ol>`;

		case FEISHU_BLOCK_TYPE.CODE: {
			const inner = renderTextElements(block.code?.elements);
			return `<pre><code>${inner}</code></pre>`;
		}

		case FEISHU_BLOCK_TYPE.QUOTE: {
			const inner = renderTextElements(block.quote?.elements);
			return `<blockquote><p>${inner}</p></blockquote>`;
		}

		case FEISHU_BLOCK_TYPE.QUOTE_CONTAINER: {
			const children = await renderBlockChildren(block, blockMap, context);
			return `<blockquote>${children}</blockquote>`;
		}

		case FEISHU_BLOCK_TYPE.TODO: {
			const done = (block.todo as any)?.style?.done === true;
			const inner = renderTextElements(block.todo?.elements);
			const checkbox = done ? '[x] ' : '[ ] ';
			return `<ul class="feishu-todo"><li>${escapeHtml(checkbox)}${inner}</li></ul>`;
		}

		case FEISHU_BLOCK_TYPE.CALLOUT: {
			const inner = renderTextElements(block.callout?.elements);
			const children = await renderBlockChildren(block, blockMap, context);
			return `<blockquote class="feishu-callout">${inner ? `<p>${inner}</p>` : ''}${children}</blockquote>`;
		}

		case FEISHU_BLOCK_TYPE.DIVIDER:
			return '<hr>';

		case FEISHU_BLOCK_TYPE.IMAGE: {
			const src = resolveImageSource(block, context);
			if (!src) {
				return renderUnsupportedBlock(block, context, '飞书图片', '未返回可用的图片标识或地址');
			}
			return buildImageHtml(src, {
				alt: block.image?.title,
				width: block.image?.width,
				height: block.image?.height,
			});
		}

		case FEISHU_BLOCK_TYPE.FILE:
			return renderFileBlock(block, context);

		case FEISHU_BLOCK_TYPE.VIEW: {
			const children = await renderBlockChildren(block, blockMap, context);
			return children || renderUnsupportedBlock(block, context, '飞书预览对象', '预览块没有返回可转换的子内容');
		}

		case FEISHU_BLOCK_TYPE.TABLE:
			return renderTable(block, blockMap, context);

		case FEISHU_BLOCK_TYPE.GRID:
		case FEISHU_BLOCK_TYPE.GRID_COLUMN:
			return renderBlockChildren(block, blockMap, context);

		case FEISHU_BLOCK_TYPE.BITABLE:
			return renderEmbeddedBitableBlock(block, context);

		case FEISHU_BLOCK_TYPE.SHEET:
			return renderEmbeddedSheetBlock(block, context);

		case FEISHU_BLOCK_TYPE.TASK:
			return renderUnsupportedBlock(
				block,
				context,
				'飞书任务卡片',
				block.task?.task_id
					? '已识别任务，但完整详情需要用户 OAuth 与 task:task:read 权限'
					: '任务块没有返回可读取的任务标识'
			);

		case FEISHU_BLOCK_TYPE.OKR: {
			const children = await renderBlockChildren(block, blockMap, context);
			return children || renderUnsupportedBlock(block, context, '飞书 OKR', 'OKR 详情需要用户身份权限');
		}

		case FEISHU_BLOCK_TYPE.OKR_OBJECTIVE: {
			const content = renderTextElements(block.okr_objective?.content?.elements);
			const children = await renderBlockChildren(block, blockMap, context);
			return content || children
				? `<section class="feishu-okr-objective">${content ? `<h3>${content}</h3>` : ''}${children}</section>`
				: renderUnsupportedBlock(block, context, '飞书 OKR 目标', '目标内容不可见或未授权');
		}

		case FEISHU_BLOCK_TYPE.OKR_KEY_RESULT: {
			const content = renderTextElements(block.okr_key_result?.content?.elements);
			const children = await renderBlockChildren(block, blockMap, context);
			return content || children
				? `<section class="feishu-okr-key-result">${content ? `<p>${content}</p>` : ''}${children}</section>`
				: renderUnsupportedBlock(block, context, '飞书 OKR 关键结果', '关键结果内容不可见或未授权');
		}

		case FEISHU_BLOCK_TYPE.OKR_PROGRESS:
			return renderUnsupportedBlock(block, context, '飞书 OKR 进展', '进展详情无法完整转换');

		case FEISHU_BLOCK_TYPE.IFRAME:
		case FEISHU_BLOCK_TYPE.WIDGET:
		case FEISHU_BLOCK_TYPE.MINDNOTE:
		case FEISHU_BLOCK_TYPE.DIAGRAM:
		case FEISHU_BLOCK_TYPE.CHAT_CARD:
			return renderEmbedBlock(block, context);

		default:
			return renderUnsupportedBlock(
				block,
				context,
				`飞书对象（块类型 ${block.block_type}）`,
				'此版本尚未识别该块类型'
			);
	}
}

async function renderTable(block: FeishuBlock, blockMap: Map<string, FeishuBlock>, context: FeishuRenderContext): Promise<string> {
	const table = block.table;
	if (!table?.property) {
		return renderUnsupportedBlock(block, context, '飞书表格', '表格结构不完整');
	}

	const rowSize = table.property.row_size || 0;
	const colSize = table.property.column_size || 0;
	const cellIds = block.children || [];

	if (!rowSize || !colSize || !cellIds.length) {
		return renderUnsupportedBlock(block, context, '飞书表格', '表格没有可转换的行列数据');
	}

	const rows: string[] = [];
	for (let r = 0; r < rowSize; r++) {
		const cells: string[] = [];
		for (let c = 0; c < colSize; c++) {
			const idx = r * colSize + c;
			const cellId = cellIds[idx];
			const cellBlock = cellId ? blockMap.get(cellId) : undefined;
			const tag = r === 0 ? 'th' : 'td';
			if (cellBlock?.children?.length) {
				const content = await renderChildren(cellBlock.children, blockMap, context);
				cells.push(`<${tag}>${content}</${tag}>`);
			} else {
				cells.push(`<${tag}></${tag}>`);
			}
		}
		rows.push(`<tr>${cells.join('')}</tr>`);
	}

	return `<table>${rows.join('')}</table>`;
}

export async function inlineFeishuMediaPlaceholders(
	content: string,
	pageUrl: string,
	options: {
		maxImages?: number;
		maxFiles?: number;
		maxDurationMs?: number;
		maxTotalBytes?: number;
		concurrency?: number;
	} = {}
): Promise<string> {
	if (!content.includes('feishu-image://') && !content.includes('feishu-file://')) return content;

	const parsedUrl = parseFeishuUrl(pageUrl);
	const objType = parsedUrl.type === 'doc' ? 'doc' : 'docx';
	const openApiHost = getFeishuOpenApiHost(pageUrl);
	const imageTokens = dedupePreserveOrder(
		Array.from(content.matchAll(/feishu-image:\/\/([\w-]+)/g), match => match[1])
	);
	const fileTokens = dedupePreserveOrder(
		Array.from(content.matchAll(/feishu-file:\/\/([\w-]+)/g), match => match[1])
	);
	const imageTokensToInline = typeof options.maxImages === 'number'
		? imageTokens.slice(0, options.maxImages)
		: imageTokens;
	const fileTokensToInline = typeof options.maxFiles === 'number'
		? fileTokens.slice(0, options.maxFiles)
		: fileTokens;

	let nextContent = content;
	let replacedImageCount = 0;
	let replacedFileCount = 0;
	let totalInlinedBytes = 0;
	const startedAt = Date.now();
	const concurrency = Math.max(1, options.concurrency || DEFAULT_FEISHU_MEDIA_INLINE_CONCURRENCY);
	const maxTotalBytes = typeof options.maxTotalBytes === 'number'
		? Math.max(0, options.maxTotalBytes)
		: MAX_TOTAL_INLINE_MEDIA_BYTES;
	const deadline = typeof options.maxDurationMs === 'number'
		? startedAt + Math.max(0, options.maxDurationMs)
		: null;

	const hasTimeBudget = () => deadline === null || Date.now() < deadline;
	const hasByteBudget = () => totalInlinedBytes < maxTotalBytes;
	const fetchTokenDataUrls = async (
		tokens: string[],
		kind: 'image' | 'file',
		maxBytes: number
	): Promise<void> => {
		let nextIndex = 0;
		const parentTypes = getMediaParentTypes(objType, kind);

		const workerCount = Math.min(concurrency, tokens.length);
		await Promise.all(Array.from({ length: workerCount }, async () => {
			while (hasTimeBudget() && hasByteBudget()) {
				const token = tokens[nextIndex++];
				if (!token) return;

				const remainingBytes = Math.max(0, maxTotalBytes - totalInlinedBytes);
				if (!remainingBytes) return;
				const media = await tryFetchFeishuMediaDataUrl(
					buildFeishuMediaDownloadUrls(openApiHost, token, parentTypes, kind),
					Math.min(maxBytes, remainingBytes),
					deadline,
					{ kind, token }
				);
				if (!media || totalInlinedBytes + media.size > maxTotalBytes) continue;

				const placeholder = kind === 'image'
					? new RegExp(
						`feishu-image:\\/\\/${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?fallback=[^"'\\s<>]+)?`,
						'g'
					)
					: buildFeishuFilePlaceholder(token);
				const hasPlaceholder = typeof placeholder === 'string'
					? nextContent.includes(placeholder)
					: placeholder.test(nextContent);
				if (!hasPlaceholder) continue;
				totalInlinedBytes += media.size;
				nextContent = typeof placeholder === 'string'
					? nextContent.split(placeholder).join(media.dataUrl)
					: nextContent.replace(placeholder, media.dataUrl);
				if (kind === 'image') replacedImageCount++;
				else replacedFileCount++;
			}
		}));
	};

	await fetchTokenDataUrls(imageTokensToInline, 'image', MAX_INLINE_IMAGE_BYTES);

	if (fileTokensToInline.length > 0 && hasTimeBudget() && hasByteBudget()) {
		await fetchTokenDataUrls(fileTokensToInline, 'file', MAX_INLINE_FILE_BYTES);
	}

	debugLog('Feishu', 'Inlined Feishu media placeholders', {
		url: redactFeishuUrl(pageUrl),
		imagePlaceholderCount: imageTokens.length,
		filePlaceholderCount: fileTokens.length,
		attemptedImageInlineCount: imageTokensToInline.length,
		attemptedFileInlineCount: fileTokensToInline.length,
		replacedImageCount,
		replacedFileCount,
		remainingImageCount: countMatches(nextContent, /feishu-image:\/\//gi),
		remainingFileCount: countMatches(nextContent, /feishu-file:\/\//gi),
		durationMs: Date.now() - startedAt,
		maxDurationMs: options.maxDurationMs,
		maxTotalBytes,
		totalInlinedBytes,
		concurrency,
	});

	return nextContent;
}

export async function extractFeishuStructuredContent(doc: Document): Promise<FeishuStructuredContent | null> {
	if (!isFeishuDocUrl(doc.URL)) return null;

	const parsedUrl = parseFeishuUrl(doc.URL);
	if (!parsedUrl.token || !parsedUrl.type) {
		debugLog('Feishu', 'Failed to parse document URL', {
			url: redactFeishuUrl(doc.URL),
		});
		return null;
	}

	const resolved = await resolveResource(parsedUrl);
	if (!resolved) {
		debugLog('Feishu', 'Failed to resolve resource ID', {
			token: redactFeishuIdentifier(parsedUrl.token),
			type: parsedUrl.type,
		});
		return null;
	}

	if (resolved.objType === 'sheet') {
		try {
			const preview = await fetchSheetResourcePreview(
				fetchFeishuApi,
				resolved.resourceId,
				doc.URL,
				doc.title || '飞书电子表格'
			);
			const rendered = renderFeishuSheetResource(
				preview.title,
				doc.URL,
				preview.sheets,
				preview.omittedSheetCount
			);
			return {
				title: preview.title,
				author: '',
				content: processUrls(rendered.content, new URL(doc.URL)),
				wordCount: rendered.wordCount,
			};
		} catch (error) {
			const fallback = renderUnsupportedFeishuResource(
				'sheet',
				doc.URL,
				doc.title || '飞书电子表格',
				getFeishuResourceErrorReason(error)
			);
			return {
				title: doc.title || '飞书电子表格',
				author: '',
				content: fallback.content,
				wordCount: fallback.wordCount,
			};
		}
	}

	if (resolved.objType === 'bitable') {
		try {
			const preview = await fetchBitableResourcePreview(
				fetchFeishuApi,
				resolved.resourceId,
				doc.URL,
				doc.title || '飞书多维表格'
			);
			const rendered = renderFeishuBitableResource(
				preview.title,
				doc.URL,
				preview.tables,
				preview.omittedTableCount
			);
			return {
				title: preview.title,
				author: '',
				content: processUrls(rendered.content, new URL(doc.URL)),
				wordCount: rendered.wordCount,
			};
		} catch (error) {
			const fallback = renderUnsupportedFeishuResource(
				'bitable',
				doc.URL,
				doc.title || '飞书多维表格',
				getFeishuResourceErrorReason(error)
			);
			return {
				title: doc.title || '飞书多维表格',
				author: '',
				content: fallback.content,
				wordCount: fallback.wordCount,
			};
		}
	}

	if (resolved.objType !== 'docx' && resolved.objType !== 'doc') {
		const fallback = renderUnsupportedFeishuResource(
			resolved.objType,
			doc.URL,
			doc.title || '飞书复杂对象',
			resolved.objType === 'task'
				? '任务卡片需要用户身份授权，当前仅保留原始入口'
				: undefined
		);
		return {
			title: doc.title || '飞书复杂对象',
			author: '',
			content: fallback.content,
			wordCount: fallback.wordCount,
		};
	}

	const [blocks, meta] = await Promise.all([
		fetchAllBlocks(resolved.resourceId),
		fetchDocumentMeta(resolved.resourceId),
	]);

	if (!blocks.length) {
		debugLog('Feishu', 'No blocks returned for document', {
			documentId: redactFeishuIdentifier(resolved.resourceId),
		});
		return null;
	}

	const context: FeishuRenderContext = {
		documentUrl: doc.URL,
		openApiHost: getFeishuOpenApiHost(doc.URL),
		objType: resolved.objType,
		domMedia: collectFeishuDomMedia(doc),
		resourcePreviewCache: new Map(),
	};

	debugLog('Feishu', 'Document structure summary', {
		url: redactFeishuUrl(doc.URL),
		documentId: redactFeishuIdentifier(resolved.resourceId),
		objType: resolved.objType,
		blockTypes: summarizeBlockTypes(blocks),
		domImages: context.domMedia.images.length,
		domVideos: context.domMedia.videos.length,
		domEmbeds: context.domMedia.embeds.length,
	});

	const content = processUrls(await convertBlocksToHtml(blocks, context), new URL(doc.URL));
	debugLog('Feishu', 'Final structured HTML summary', {
		url: redactFeishuUrl(doc.URL),
		imgCount: countMatches(content, /<img\b/gi),
		videoCount: countMatches(content, /<video\b/gi),
		iframeCount: countMatches(content, /<iframe\b/gi),
		contentLength: content.length,
	});
	const title = meta?.title || doc.title || '';

	const textContent = blocks
		.map(b => {
			const body = getTextBody(b);
			if (!body?.elements) return '';
			return body.elements
				.map(el => el.text_run?.content || '')
				.join('');
		})
		.join('\n')
		.trim();

	const wordCount = textContent.split(/\s+/).filter(Boolean).length || textContent.length;

	return {
		title,
		author: meta?.owner || '',
		content,
		wordCount,
	};
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
