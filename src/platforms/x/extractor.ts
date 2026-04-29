import browser from '../../utils/browser-polyfill';

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

const X_STATUS_PATTERN = /^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i;
const VIDEO_URL_PATTERN = /^https:\/\/video\.twimg\.com\/.+\.(?:mp4|m3u8)(?:[?#].*)?$/i;
const SHOW_MORE_PATTERN = /\bshow more\b|\bread more\b|显示更多|查看更多|展开全文|展开更多|查看全部/i;
const SHOW_MORE_EXCLUDE_PATTERN = /\bshow more repl(?:y|ies)\b|\breplies\b|\breply\b|\bcomments?\b|\bmore menu\b|回复|评论|更多菜单/i;

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
	const response = await browser.runtime.sendMessage({
		action: 'xExtractVideoCandidate',
		url,
	}).catch(() => null) as { success?: boolean; candidate?: XVideoCandidate | null } | null;
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

async function expandXPrimaryShowMore(doc: Document): Promise<number> {
	const scope = getPrimaryTweetScope(doc);
	let clickedCount = 0;

	for (let round = 0; round < 3; round++) {
		const controls = Array.from(scope.querySelectorAll<HTMLElement>(
			'button, [role="button"], a[href]'
		));
		const target = controls.find((control) => {
			const text = getVisibleText(control);
			if (!SHOW_MORE_PATTERN.test(text)) return false;
			if (SHOW_MORE_EXCLUDE_PATTERN.test(text)) return false;
			return !control.closest('[aria-label*="Reply"], [aria-label*="reply"]');
		});
		if (!target) break;

		target.click();
		clickedCount++;
		await wait(500);
	}

	return clickedCount;
}

export async function hydrateXMediaBeforeExtract(doc: Document): Promise<void> {
	const win = doc.defaultView;
	if (!win || !isXStatusUrl(doc.URL || win.location.href)) return;
	if (!doc.querySelector('[data-testid="longformRichTextComponent"], article, video')) return;

	const originalY = win.scrollY;
	await expandXPrimaryShowMore(doc);
	const maxSteps = doc.querySelector('[data-testid="longformRichTextComponent"]') ? 10 : 4;

	for (let index = 0; index < maxSteps; index++) {
		win.scrollBy(0, Math.max(400, Math.floor(win.innerHeight * 0.85)));
		await wait(450);
		if (index >= 3 && doc.querySelector('video')) break;
	}

	win.scrollTo(0, originalY);
	await wait(100);
}

export async function extractXVideoCandidate(url: string): Promise<XVideoCandidate | null> {
	const tweetId = getTweetId(url);
	if (!tweetId) return null;

	const mainWorldCandidate = await extractFromMainWorld(url);
	if (mainWorldCandidate) return mainWorldCandidate;

	return chooseBestCandidate([
		...extractFromInitialState(tweetId),
		...extractFromDom(),
		...extractFromPerformance(),
	]);
}

export async function appendXVideoFallback(content: string, pageUrl: string, doc?: Document): Promise<string> {
	const candidate = await extractXVideoCandidate(pageUrl);
	const contentWithBlobFallbacks = replaceXBlobVideos(content, pageUrl, candidate);
	if (contentWithBlobFallbacks !== content) return contentWithBlobFallbacks;
	let nextContent = content;
	if (candidate && !nextContent.includes(candidate.url)) {
		nextContent = insertXVideoSectionNearTweetMedia(nextContent, buildXVideoSection(candidate), pageUrl);
	}

	for (const threadUrl of collectThreadStatusUrls(content, pageUrl, doc)) {
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
