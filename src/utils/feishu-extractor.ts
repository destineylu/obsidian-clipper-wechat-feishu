import browser from './browser-polyfill';
import { processUrls } from './string-utils';
import { debugLog } from './debug';

export interface FeishuParsedUrl {
	type: 'wiki' | 'docx' | 'doc' | null;
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
	view?: object;
	undefined_block?: object;
}

interface FeishuDomVideo {
	src: string;
	poster?: string;
}

interface FeishuDomMedia {
	images: string[];
	videos: FeishuDomVideo[];
	embeds: string[];
}

interface FeishuRenderContext {
	documentUrl: string;
	openApiHost: string;
	objType: string;
	domMedia: FeishuDomMedia;
}

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;
const FEISHU_MEDIA_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_FEISHU_MEDIA_INLINE_CONCURRENCY = 4;

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
} as const;

export function isFeishuDocUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const isFeishuHost = parsed.hostname.endsWith('.feishu.cn') || parsed.hostname.endsWith('.larksuite.com');
		if (!isFeishuHost) return false;
		return /^\/(wiki|docx|docs?)\/[\w-]+/.test(parsed.pathname);
	} catch {
		return false;
	}
}

export function parseFeishuUrl(url: string): FeishuParsedUrl {
	try {
		const parsed = new URL(url);
		const match = parsed.pathname.match(/^\/(wiki|docx|docs?)\/([\w-]+)/);
		if (!match) return { type: null, token: null };
		const rawType = match[1];
		const normalizedType = (rawType === 'docs' ? 'doc' : rawType) as 'wiki' | 'docx' | 'doc';
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
		console.warn('[Feishu Clipper] API request failed:', errMsg, 'URL:', url);
		throw new Error(errMsg);
	}
	return response.data;
}

async function fetchFeishuMediaAsDataUrl(url: string, maxBytes = MAX_INLINE_IMAGE_BYTES): Promise<string> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(`Feishu media fetch timed out after ${FEISHU_MEDIA_FETCH_TIMEOUT_MS}ms`));
		}, FEISHU_MEDIA_FETCH_TIMEOUT_MS);
	});

	const response = await Promise.race([
		browser.runtime.sendMessage({
			action: 'fetchFeishuMedia',
			url,
			maxBytes,
		}) as Promise<{ success?: boolean; data?: { dataUrl?: string }; error?: string }>,
		timeoutPromise,
	]).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
	});

	if (!response?.success || !response.data?.dataUrl) {
		throw new Error(response?.error || 'Failed to fetch Feishu media');
	}

	return response.data.dataUrl;
}

async function resolveDocumentId(parsedUrl: FeishuParsedUrl): Promise<{ documentId: string; objType: string } | null> {
	if (!parsedUrl.token) return null;

	if (parsedUrl.type === 'wiki') {
		const result = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${parsedUrl.token}`
		);
		const node = result?.data?.node;
		if (!node?.obj_token) {
			console.warn('[Feishu Clipper] Wiki get_node returned no obj_token. Response:', JSON.stringify(result).slice(0, 500));
			return null;
		}
		return { documentId: node.obj_token, objType: node.obj_type || 'docx' };
	}

	return { documentId: parsedUrl.token, objType: parsedUrl.type === 'doc' ? 'doc' : 'docx' };
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

function buildFeishuImagePlaceholder(token: string): string {
	return `feishu-image://${token}`;
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
		...parentTypes.map(parentType => `${openApiHost}/open-apis/drive/v1/medias/${encodedToken}/download?parent_type=${encodeURIComponent(parentType)}`),
		`${openApiHost}/open-apis/drive/v1/media/${encodedToken}/download`,
	];

	if (mediaKind === 'file') {
		return [
			`${openApiHost}/open-apis/drive/v1/files/${encodedToken}/download`,
			...mediaUrls,
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

async function tryFetchFeishuMediaDataUrl(urls: string[], maxBytes: number, context?: { kind: 'image' | 'file'; token?: string; name?: string }): Promise<string | null> {
	for (const url of urls) {
		try {
			return await fetchFeishuMediaAsDataUrl(url, maxBytes);
		} catch (error) {
			debugLog('Feishu', 'Media fetch candidate failed', {
				error: error instanceof Error ? error.message : String(error),
				url,
				kind: context?.kind,
				token: context?.token,
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

function collectFeishuDomMedia(doc: Document): FeishuDomMedia {
	const images = Array.from(doc.querySelectorAll('img'))
		.filter(shouldKeepDomImage)
		.map(img => img.currentSrc || img.src)
		.filter(isSafeMediaUrl);

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
		const placeholder = buildFeishuImagePlaceholder(token);
		console.log('[Feishu Clipper] Resolved image block to placeholder:', {
			blockType: block.block_type,
			token,
			title: block.image?.title,
			width: block.image?.width,
			height: block.image?.height,
		});
		return placeholder;
	}

	const domCandidate = context.domMedia.images.shift() || null;
	if (!domCandidate) return null;

	console.log('[Feishu Clipper] Resolved image block from DOM URL:', {
		blockType: block.block_type,
		token,
		origin: describeMediaOrigin(domCandidate),
	});
	return domCandidate;
}

function resolveVideoSource(file: FeishuFileBlock | undefined, context: FeishuRenderContext): { src: string; poster?: string } | null {
	const token = file?.token;
	if (token) {
		const placeholder = buildFeishuFilePlaceholder(token);
		console.log('[Feishu Clipper] Resolved video/file block to placeholder:', {
			token,
			name: file?.name,
			mimeType: file?.mime_type,
		});
		return { src: placeholder };
	}

	const domCandidate = context.domMedia.videos.shift() || null;
	if (domCandidate) {
		console.log('[Feishu Clipper] Resolved video from DOM URL:', {
			token: file?.token,
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

function renderEmbedBlock(block: FeishuBlock, context: FeishuRenderContext): string {
	const embedUrl = extractEmbedUrl(block) || context.domMedia.embeds.shift() || context.documentUrl;
	const title = block.iframe?.title || block.widget?.title || block.chat_card?.title || block.iframe?.name || block.widget?.name || block.chat_card?.name || 'Open embedded content';
	if (/\.(mp4|mov|m4v|webm|ogg|ogv)(\?|#|$)/i.test(embedUrl)) {
		return buildVideoHtml(embedUrl, { title });
	}
	if (/^https?:/i.test(embedUrl)) {
		return `<figure><iframe src="${escapeAttr(embedUrl)}" loading="lazy" allowfullscreen></iframe><figcaption><a href="${escapeAttr(embedUrl)}">${escapeHtml(title)}</a></figcaption></figure>`;
	}
	return `<p><a href="${escapeAttr(context.documentUrl)}">${escapeHtml(title)}</a></p>`;
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
			console.log('[Feishu Clipper] Rendered file block as video:', {
				blockType: block.block_type,
				token: file?.token,
				name: fileName,
				origin: describeMediaOrigin(video.src),
			});
			return buildVideoHtml(video.src, { title: fileName, poster: video.poster });
		}
	}

	if (isLikelyImageFile(file?.name, file?.mime_type) && file?.token) {
		const src = buildFeishuFilePlaceholder(file.token);
		console.log('[Feishu Clipper] Rendered file block as image placeholder:', {
			blockType: block.block_type,
			token: file.token,
			name: fileName,
		});
		return buildImageHtml(src, { alt: fileName });
	}

	if (file?.token) {
		const placeholder = buildFeishuFilePlaceholder(file.token);
		console.log('[Feishu Clipper] Rendered file block as placeholder link:', {
			blockType: block.block_type,
			token: file.token,
			name: fileName,
			placeholder,
		});
		return `<p><a href="${escapeAttr(placeholder)}">${escapeHtml(fileName)}</a></p>`;
	}

	console.log('[Feishu Clipper] Rendered file block as document fallback:', {
		blockType: block.block_type,
		name: fileName,
		documentUrl: context.documentUrl,
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
			if (!src) return '';
			return buildImageHtml(src, {
				alt: block.image?.title,
				width: block.image?.width,
				height: block.image?.height,
			});
		}

		case FEISHU_BLOCK_TYPE.FILE:
			return renderFileBlock(block, context);

		case FEISHU_BLOCK_TYPE.VIEW:
			return renderBlockChildren(block, blockMap, context);

		case FEISHU_BLOCK_TYPE.TABLE:
			return renderTable(block, blockMap, context);

		case FEISHU_BLOCK_TYPE.GRID:
		case FEISHU_BLOCK_TYPE.GRID_COLUMN:
			return renderBlockChildren(block, blockMap, context);

		case FEISHU_BLOCK_TYPE.IFRAME:
		case FEISHU_BLOCK_TYPE.WIDGET:
		case FEISHU_BLOCK_TYPE.SHEET:
		case FEISHU_BLOCK_TYPE.MINDNOTE:
		case FEISHU_BLOCK_TYPE.DIAGRAM:
		case FEISHU_BLOCK_TYPE.CHAT_CARD:
			return renderEmbedBlock(block, context);

		default:
			return '';
	}
}

async function renderTable(block: FeishuBlock, blockMap: Map<string, FeishuBlock>, context: FeishuRenderContext): Promise<string> {
	const table = block.table;
	if (!table?.property) return '';

	const rowSize = table.property.row_size || 0;
	const colSize = table.property.column_size || 0;
	const cellIds = block.children || [];

	if (!rowSize || !colSize || !cellIds.length) return '';

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
	options: { maxImages?: number; maxFiles?: number; maxDurationMs?: number; concurrency?: number } = {}
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
	const startedAt = Date.now();
	const concurrency = Math.max(1, options.concurrency || DEFAULT_FEISHU_MEDIA_INLINE_CONCURRENCY);

	const hasTimeBudget = () => typeof options.maxDurationMs !== 'number' || Date.now() - startedAt < options.maxDurationMs;
	const fetchTokenDataUrls = async (
		tokens: string[],
		kind: 'image' | 'file',
		maxBytes: number
	): Promise<Map<string, string>> => {
		const dataUrls = new Map<string, string>();
		let nextIndex = 0;
		const parentTypes = getMediaParentTypes(objType, kind);

		const workerCount = Math.min(concurrency, tokens.length);
		await Promise.all(Array.from({ length: workerCount }, async () => {
			while (hasTimeBudget()) {
				const token = tokens[nextIndex++];
				if (!token) return;

				const dataUrl = await tryFetchFeishuMediaDataUrl(
					buildFeishuMediaDownloadUrls(openApiHost, token, parentTypes, kind),
					maxBytes,
					{ kind, token }
				);
				if (dataUrl) {
					dataUrls.set(token, dataUrl);
				}
			}
		}));

		return dataUrls;
	};

	const imageDataUrls = await fetchTokenDataUrls(imageTokensToInline, 'image', MAX_INLINE_IMAGE_BYTES);
	for (const [token, dataUrl] of imageDataUrls) {
		const placeholder = buildFeishuImagePlaceholder(token);
		if (nextContent.includes(placeholder)) {
			nextContent = nextContent.split(placeholder).join(dataUrl);
			replacedImageCount++;
		}
	}

	if (fileTokensToInline.length > 0 && hasTimeBudget()) {
		const fileDataUrls = await fetchTokenDataUrls(fileTokensToInline, 'file', MAX_INLINE_FILE_BYTES);
		for (const [token, dataUrl] of fileDataUrls) {
			const placeholder = buildFeishuFilePlaceholder(token);
			if (nextContent.includes(placeholder)) {
				nextContent = nextContent.split(placeholder).join(dataUrl);
				replacedFileCount++;
			}
		}
	}

	console.log('[Feishu Clipper] Inlined Feishu media placeholders:', {
		url: pageUrl,
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
		concurrency,
	});

	return nextContent;
}

export async function extractFeishuStructuredContent(doc: Document): Promise<FeishuStructuredContent | null> {
	if (!isFeishuDocUrl(doc.URL)) return null;

	const parsedUrl = parseFeishuUrl(doc.URL);
	if (!parsedUrl.token || !parsedUrl.type) {
		console.warn('[Feishu Clipper] Failed to parse URL:', doc.URL);
		return null;
	}

	const resolved = await resolveDocumentId(parsedUrl);
	if (!resolved) {
		console.warn('[Feishu Clipper] Failed to resolve document ID for token:', parsedUrl.token, 'type:', parsedUrl.type);
		return null;
	}

	const [blocks, meta] = await Promise.all([
		fetchAllBlocks(resolved.documentId),
		fetchDocumentMeta(resolved.documentId),
	]);

	if (!blocks.length) {
		console.warn('[Feishu Clipper] No blocks returned for document:', resolved.documentId);
		return null;
	}

	const context: FeishuRenderContext = {
		documentUrl: doc.URL,
		openApiHost: getFeishuOpenApiHost(doc.URL),
		objType: resolved.objType,
		domMedia: collectFeishuDomMedia(doc),
	};

	console.log('[Feishu Clipper] Document structure summary:', {
		url: doc.URL,
		documentId: resolved.documentId,
		objType: resolved.objType,
		blockTypes: summarizeBlockTypes(blocks),
		domImages: context.domMedia.images.length,
		domVideos: context.domMedia.videos.length,
		domEmbeds: context.domMedia.embeds.length,
	});

	const content = processUrls(await convertBlocksToHtml(blocks, context), new URL(doc.URL));
	console.log('[Feishu Clipper] Final structured HTML summary:', {
		url: doc.URL,
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
