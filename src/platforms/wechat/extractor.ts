import { debugLog } from '../../utils/debug';

function isUsefulImageUrl(value: string | null): value is string {
	if (!value) return false;
	if (/^data:image\/svg\+xml/i.test(value)) return false;
	if (/^data:image\/gif/i.test(value) && value.length < 200) return false;
	return true;
}

function resolveImageUrl(value: string, baseUrl: string): string {
	const cleanValue = value.replace(/#imgIndex=.*$/i, '');
	const url = new URL(cleanValue, baseUrl);
	if (url.hostname.endsWith('mmbiz.qpic.cn') && /^#imgIndex=/i.test(url.hash)) {
		url.hash = '';
	}
	return url.href;
}

function getLazyImageUrl(img: HTMLImageElement): string | null {
	const lazyAttributes = [
		'data-src',
		'data-original',
		'data-actualsrc',
		'data-lazy-src',
		'data-backsrc',
		'data-url',
		'data-echo',
	];

	for (const attr of lazyAttributes) {
		const value = img.getAttribute(attr);
		if (isUsefulImageUrl(value)) return value;
	}

	return null;
}

export function normalizeLazyImages(doc: Document, baseUrl: string): void {
	let parsedUrl: URL | null = null;
	try {
		parsedUrl = new URL(baseUrl);
	} catch {
		parsedUrl = null;
	}
	const isWeChatArticle = parsedUrl?.hostname === 'mp.weixin.qq.com';

	doc.querySelectorAll('img').forEach((img) => {
		const image = img as HTMLImageElement;
		const currentSrc = image.getAttribute('src');
		const lazySrc = getLazyImageUrl(image);
		const nextSrc = isWeChatArticle ? lazySrc : (isUsefulImageUrl(currentSrc) ? null : lazySrc);
		if (!nextSrc) return;

		try {
			image.setAttribute('src', resolveImageUrl(nextSrc, baseUrl));
			image.removeAttribute('srcset');
			image.removeAttribute('data-srcset');
		} catch {
			image.setAttribute('src', nextSrc);
		}
	});
}

function isWeChatArticleUrl(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === 'mp.weixin.qq.com';
	} catch {
		return false;
	}
}

function countImageTags(html: string): number {
	return html.match(/<img\b/gi)?.length || 0;
}

function getPlainTextLength(html: string): number {
	const doc = new DOMParser().parseFromString(html || '', 'text/html');
	return (doc.body.textContent || '').replace(/\s+/g, '').length;
}

function getWeChatVideoArticleUrl(container: Element, baseUrl: string): string | null {
	const videoId = container.getAttribute('data-mpvid') || container.getAttribute('vid') || container.getAttribute('data-vid');
	if (!videoId) return null;

	try {
		const url = new URL(baseUrl);
		const anchorId = container.id;
		if (anchorId) {
			url.hash = anchorId;
		}
		return url.href;
	} catch {
		return baseUrl;
	}
}

function getWeChatVideoCover(container: Element): string | null {
	const rawCover = container.getAttribute('data-cover');
	if (!rawCover) return null;

	try {
		const decoded = decodeURIComponent(rawCover);
		return decoded.replace(/^http:\/\//i, 'https://');
	} catch {
		return rawCover.replace(/^http:\/\//i, 'https://');
	}
}

function appendOriginalArticleLink(doc: Document, label: string, baseUrl: string): HTMLElement {
	const paragraph = doc.createElement('p');
	const link = doc.createElement('a');
	link.href = baseUrl;
	link.textContent = label;
	paragraph.appendChild(link);
	return paragraph;
}

function replaceWeChatVideosWithLinks(article: Element, baseUrl: string): void {
	const videoContainers = Array.from(
		article.querySelectorAll('.video_iframe[data-src], [data-mpvid][data-src], iframe[data-src*="video_player_tmpl"]')
	).filter(container => !container.parentElement?.closest('.video_iframe[data-src], [data-mpvid][data-src], iframe[data-src*="video_player_tmpl"]'));

	videoContainers.forEach((container, index) => {
		const articleUrl = getWeChatVideoArticleUrl(container, baseUrl);
		if (!articleUrl) return;

		const doc = container.ownerDocument;
		const figure = doc.createElement('figure');
		const caption = doc.createElement('figcaption');
		const captionLink = doc.createElement('a');
		const videoId = container.getAttribute('data-mpvid') || container.getAttribute('vid') || container.getAttribute('data-vid') || String(index + 1);
		captionLink.href = articleUrl;
		captionLink.textContent = `微信视频未内联：${videoId}（打开原文播放）`;
		caption.appendChild(captionLink);

		const coverUrl = getWeChatVideoCover(container);
		if (coverUrl) {
			const link = doc.createElement('a');
			link.href = articleUrl;
			const img = doc.createElement('img');
			img.src = coverUrl;
			img.alt = `微信视频封面：${videoId}`;
			link.appendChild(img);
			figure.appendChild(link);
		}

		figure.appendChild(caption);
		container.replaceWith(figure);
	});
}

function replaceWeChatAudioWithLinks(article: Element, baseUrl: string): void {
	const audioContainers = Array.from(
		article.querySelectorAll('mp-common-mpaudio, mpvoice, qqmusic, [data-pluginname="insertaudio"]')
	);

	audioContainers.forEach((container, index) => {
		const title = [
			container.getAttribute('data-name'),
			container.getAttribute('data-music_name'),
			container.getAttribute('name'),
			container.getAttribute('title'),
			container.textContent?.trim(),
		].find(value => value && value.trim()) || String(index + 1);
		container.replaceWith(appendOriginalArticleLink(container.ownerDocument, `微信音频未内联：${title}（打开原文播放）`, baseUrl));
	});
}

function sanitizeAttributes(el: Element): void {
	const tagName = el.tagName.toLowerCase();
	const keepByTag: Record<string, Set<string>> = {
		a: new Set(['href', 'title']),
		img: new Set(['src', 'alt', 'title', 'width', 'height']),
		td: new Set(['colspan', 'rowspan']),
		th: new Set(['colspan', 'rowspan']),
	};
	const keep = keepByTag[tagName] || new Set<string>();
	for (const attr of Array.from(el.attributes)) {
		if (keep.has(attr.name.toLowerCase())) continue;
		el.removeAttribute(attr.name);
	}
}

function removeEmptyLayoutElements(article: Element): void {
	let removed = 0;
	do {
		removed = 0;
		article.querySelectorAll('section, span, p, div').forEach(el => {
			if (el.querySelector('img, video, audio, iframe, table, a, br')) return;
			if (el.textContent?.trim()) return;
			el.remove();
			removed++;
		});
	} while (removed > 0);
}

function cleanClonedArticle(article: Element, baseUrl: string): string {
	const clone = article.cloneNode(true) as Element;
	if (isWeChatArticleUrl(baseUrl)) {
		replaceWeChatVideosWithLinks(clone, baseUrl);
		replaceWeChatAudioWithLinks(clone, baseUrl);
	}
	clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
	clone.querySelectorAll('video[src*="mpvideo.qpic.cn"]').forEach(el => el.remove());
	clone.querySelectorAll('img').forEach(img => {
		const src = isUsefulImageUrl(img.getAttribute('src')) ? img.getAttribute('src') : getLazyImageUrl(img as HTMLImageElement);
		if (isUsefulImageUrl(src)) {
			try {
				img.setAttribute('src', resolveImageUrl(src, baseUrl));
			} catch {
				// Keep the existing src if URL normalization fails.
			}
		} else {
			img.remove();
		}
	});
	clone.querySelectorAll('*').forEach(el => {
		sanitizeAttributes(el);
	});
	removeEmptyLayoutElements(clone);
	return clone.innerHTML;
}

function extractWeChatArticleContent(doc: Document, baseUrl: string): string | null {
	if (!isWeChatArticleUrl(baseUrl)) return null;

	const article = doc.querySelector('#js_content') || doc.querySelector('.rich_media_content');
	if (!article) return null;

	const content = cleanClonedArticle(article, baseUrl);
	return countImageTags(content) > 0 || /微信视频：/i.test(content) ? content : null;
}

export function applyWeChatContentFallback(doc: Document, parsed: any, baseUrl: string): any {
	const weChatContent = extractWeChatArticleContent(doc, baseUrl);
	if (!weChatContent) return parsed;

	const parsedImageCount = countImageTags(parsed?.content || '');
	const weChatImageCount = countImageTags(weChatContent);
	const parsedTextLength = getPlainTextLength(parsed?.content || '');
	const weChatTextLength = getPlainTextLength(weChatContent);
	const hasBetterImages = weChatImageCount > parsedImageCount;
	const hasMuchMoreText = weChatTextLength > Math.max(parsedTextLength * 1.5, parsedTextLength + 500);
	if (!hasBetterImages && !hasMuchMoreText) return parsed;

	debugLog('Clipper', 'Using WeChat article content fallback', {
		url: baseUrl,
		parsedImageCount,
		weChatImageCount,
		parsedTextLength,
		weChatTextLength,
	});

	return {
		...parsed,
		content: weChatContent,
	};
}
