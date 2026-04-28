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

export function isXStatusUrl(url: string): boolean {
	return X_STATUS_PATTERN.test(url);
}

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

function chooseBestVariant(variants: XVideoVariant[]): XVideoVariant | null {
	const usable = variants
		.filter(variant => variant.url && VIDEO_URL_PATTERN.test(variant.url))
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
			if (!VIDEO_URL_PATTERN.test(source)) return null;
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
		.filter(url => VIDEO_URL_PATTERN.test(url))
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

export async function appendXVideoFallback(content: string, pageUrl: string): Promise<string> {
	const candidate = await extractXVideoCandidate(pageUrl);
	if (!candidate || content.includes(candidate.url)) return content;

	const lines = [
		'<hr>',
		'<section data-obsidian-clipper-x-video="true">',
		'<h2>X 视频</h2>',
		`<p><a href="${escapeHtml(candidate.url)}">X视频未内联：下载/打开视频</a></p>`,
	];
	if (candidate.poster) {
		lines.push(`<p><a href="${escapeHtml(candidate.url)}"><img src="${escapeHtml(candidate.poster)}" alt="X视频封面"></a></p>`);
	}
	lines.push('</section>');

	console.log('[X Clipper] Added video fallback:', {
		pageUrl,
		videoUrl: candidate.url,
		poster: candidate.poster,
		source: candidate.source,
		bitrate: candidate.bitrate,
		contentType: candidate.contentType,
	});

	return `${content}${lines.join('')}`;
}
