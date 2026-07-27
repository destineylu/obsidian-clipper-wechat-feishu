import { PlatformBackgroundHandler } from '../types';

const X_STATUS_PATTERN = /^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i;

interface XVideoCandidate {
	id: string;
	poster?: string;
	url: string;
	bitrate?: number;
	contentType?: string;
	source: string;
}

interface XVideoVariant {
	bit_rate?: number;
	bitrate?: number;
	content_type?: string;
	url?: string;
}

function isXStatusUrl(url: string): boolean {
	return X_STATUS_PATTERN.test(url);
}

function normalizeXVideoUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.searchParams.delete('container');
		return parsed.href;
	} catch {
		return url;
	}
}

function sortXVideoCandidates(candidates: XVideoCandidate[]): XVideoCandidate[] {
	const byUrl = new Map<string, XVideoCandidate>();
	for (const candidate of candidates) {
		if (!candidate.url) continue;
		const existing = byUrl.get(candidate.url);
		if (!existing || (candidate.bitrate || 0) > (existing.bitrate || 0)) {
			byUrl.set(candidate.url, candidate);
		}
	}
	return Array.from(byUrl.values()).sort((left, right) => {
		const leftIsMp4 = left.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(left.url);
		const rightIsMp4 = right.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(right.url);
		if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
		return (right.bitrate || 0) - (left.bitrate || 0);
	});
}

export async function extractXSyndicationVideoCandidates(
	pageUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<XVideoCandidate[]> {
	const tweetId = pageUrl.match(X_STATUS_PATTERN)?.[1] || '';
	if (!tweetId) return [];

	// This is the deterministic token used by X's own public embed client.
	const token = ((Number(tweetId) / 1e15) * Math.PI)
		.toString(36)
		.replace(/(0+|\.)/g, '');
	const endpoint = new URL('https://cdn.syndication.twimg.com/tweet-result');
	endpoint.searchParams.set('id', tweetId);
	endpoint.searchParams.set('lang', 'en');
	endpoint.searchParams.set('token', token);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 4000);
	try {
		const response = await fetchImpl(endpoint.href, {
			credentials: 'omit',
			signal: controller.signal,
		});
		if (!response.ok) return [];
		const data = await response.json() as {
			mediaDetails?: Array<{
				id_str?: string;
				media_key?: string;
				media_url_https?: string;
				type?: string;
				video_info?: {
					variants?: XVideoVariant[];
				};
			}>;
		};
		const candidates = (Array.isArray(data.mediaDetails) ? data.mediaDetails : [])
			.filter(media => media.type === 'video' || media.type === 'animated_gif')
			.map((media, mediaIndex): XVideoCandidate | null => {
				const variant = (Array.isArray(media.video_info?.variants) ? media.video_info.variants : [])
					.filter(variant =>
						typeof variant.url === 'string'
						&& /^https:\/\/video\.twimg\.com\/.+\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(variant.url)
					)
					.sort((left, right) => {
						const leftIsMp4 = left.content_type === 'video/mp4'
							|| /\.mp4(?:[?#]|$)/i.test(left.url || '');
						const rightIsMp4 = right.content_type === 'video/mp4'
							|| /\.mp4(?:[?#]|$)/i.test(right.url || '');
						if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
						return (right.bitrate || right.bit_rate || 0)
							- (left.bitrate || left.bit_rate || 0);
					})[0];
				if (!variant?.url) return null;
				return {
					id: media.id_str || media.media_key || `${tweetId}-${mediaIndex}`,
					poster: media.media_url_https,
					url: normalizeXVideoUrl(variant.url),
					bitrate: variant.bitrate || variant.bit_rate,
					contentType: variant.content_type,
					source: 'syndication',
				};
			})
			.filter((candidate): candidate is XVideoCandidate => !!candidate);
		return sortXVideoCandidates(candidates);
	} catch {
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

export async function extractXVideoCandidateInMainWorld(pageUrl: string): Promise<{ candidate: XVideoCandidate | null; candidates: XVideoCandidate[] }> {
	const tweetId = pageUrl.match(/^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i)?.[1] || '';
	if (!tweetId) return { candidate: null, candidates: [] };

	const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
	const videoUrlPattern = /^https:\/\/video\.twimg\.com\/.+\.(?:mp4|m3u8)(?:[?#].*)?$/i;
	const normalizeVideoUrl = (url: string): string => {
		try {
			const parsed = new URL(url);
			parsed.searchParams.delete('container');
			return parsed.href;
		} catch {
			return url;
		}
	};
	const sortCandidates = (candidates: XVideoCandidate[]): XVideoCandidate[] => {
		const byUrl = new Map<string, XVideoCandidate>();
		for (const candidate of candidates) {
			if (!candidate.url) continue;
			const existing = byUrl.get(candidate.url);
			if (!existing || (candidate.bitrate || 0) > (existing.bitrate || 0)) {
				byUrl.set(candidate.url, candidate);
			}
		}
		return Array.from(byUrl.values()).sort((left, right) => {
			const leftIsMp4 = left.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(left.url);
			const rightIsMp4 = right.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(right.url);
			if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
			return (right.bitrate || 0) - (left.bitrate || 0);
		});
	};
	const collectMediaObjects = (root: unknown): Record<string, unknown>[] => {
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
				if (isObject(value) || Array.isArray(value)) stack.push(value);
			}
		}
		return found;
	};
	const findTweetObjects = (root: unknown): Record<string, unknown>[] => {
		const found: Record<string, unknown>[] = [];
		const seen = new Set<unknown>();
		const stack: unknown[] = [root];
		while (stack.length) {
			const current = stack.pop();
			if (!isObject(current) || seen.has(current)) continue;
			seen.add(current);
			if (current.id_str === tweetId || current.rest_id === tweetId) found.push(current);
			for (const value of Object.values(current)) {
				if (isObject(value) || Array.isArray(value)) stack.push(value);
			}
		}
		return found;
	};
	const fromMediaObject = (media: Record<string, unknown>): XVideoCandidate | null => {
		const mediaInfo = isObject(media.media_info) ? media.media_info : null;
		const videoInfo = isObject(media.video_info) ? media.video_info : mediaInfo;
		if (!isObject(videoInfo) || !Array.isArray(videoInfo.variants)) return null;
		const variant = (videoInfo.variants as XVideoVariant[])
			.filter(item => item.url && videoUrlPattern.test(item.url))
			.sort((left, right) => {
				const leftIsMp4 = left.content_type === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(left.url || '');
				const rightIsMp4 = right.content_type === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(right.url || '');
				if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
				return (right.bitrate || right.bit_rate || 0) - (left.bitrate || left.bit_rate || 0);
			})[0];
		if (!variant?.url) return null;
		const previewImage = isObject(mediaInfo?.preview_image) ? mediaInfo.preview_image : null;
		return {
			id: String(media.id_str || media.media_id || media.media_key || variant.url),
			poster: typeof media.media_url_https === 'string'
				? media.media_url_https
				: typeof previewImage?.original_img_url === 'string'
					? previewImage.original_img_url
					: undefined,
			url: normalizeVideoUrl(variant.url),
			bitrate: variant.bitrate || variant.bit_rate,
			contentType: variant.content_type,
			source: 'main-world-initial-state',
		};
	};
	const getCookie = (name: string): string => {
		const value = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1] || '';
		return decodeURIComponent(value);
	};
	const extractBearerTokenFromSource = (source: string): string => {
		const bearerMatch = source.match(/Bearer (AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]+)/);
		if (bearerMatch?.[1]?.includes('NRILg')) {
			return decodeURIComponent(bearerMatch[1]);
		}
		const rawMatch = source.match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]+)"/);
		if (rawMatch?.[1]?.includes('NRILg')) {
			return decodeURIComponent(rawMatch[1]);
		}
		return '';
	};
	const getBearerTokenFromWebpack = (): string => {
		try {
			let webpackRequire: { m?: Record<string, unknown> } | undefined;
			(window as typeof window & { webpackChunk_twitter_responsive_web?: unknown[] })
				.webpackChunk_twitter_responsive_web
				?.push([[Math.random()], {}, (require: { m?: Record<string, unknown> }) => {
					webpackRequire = require;
				}]);

			const moduleSources = Object.values(webpackRequire?.m || {}).map(moduleFactory => String(moduleFactory));
			for (const source of moduleSources) {
				const token = extractBearerTokenFromSource(source);
				if (token) return token;
			}
		} catch {
			// X changes the webpack runtime occasionally; try the loaded scripts next.
		}
		return '';
	};
	const getBearerToken = async (): Promise<string> => {
		const webpackToken = getBearerTokenFromWebpack();
		if (webpackToken) return webpackToken;

		const inlineToken = Array.from(document.scripts)
			.map(script => extractBearerTokenFromSource(script.textContent || ''))
			.find(Boolean);
		if (inlineToken) return inlineToken;

		const scriptUrls = Array.from(new Set(
			Array.from(document.scripts)
				.map(script => script.src)
				.filter(src => {
					try {
						const parsed = new URL(src, window.location.href);
						return parsed.protocol === 'https:'
							&& /(?:^|\.)twimg\.com$/i.test(parsed.hostname)
							&& /\/responsive-web\/client-web\/.+\.js$/i.test(parsed.pathname);
					} catch {
						return false;
					}
				})
		)).sort((left, right) => {
			const leftIsMain = /\/main\.[^/]+\.js$/i.test(left);
			const rightIsMain = /\/main\.[^/]+\.js$/i.test(right);
			if (leftIsMain !== rightIsMain) return leftIsMain ? -1 : 1;
			return 0;
		});

		for (const scriptUrl of scriptUrls.slice(0, 4)) {
			try {
				const controller = new AbortController();
				const timeout = window.setTimeout(() => controller.abort(), 2500);
				const source = await fetch(scriptUrl, {
					credentials: 'omit',
					signal: controller.signal,
				}).then(response => response.ok ? response.text() : '')
					.finally(() => window.clearTimeout(timeout));
				const token = extractBearerTokenFromSource(source);
				if (token) return token;
			} catch {
				// Try the next loaded X client script.
			}
		}
		return '';
	};
	const getPerformanceResourceUrls = (): string[] => {
		try {
			return performance.getEntriesByType('resource')
				.map(entry => entry.name)
				.filter(Boolean);
		} catch {
			return [];
		}
	};
	const discoveredTweetResultUrls = (): string[] => {
		const discovered: string[] = [];
		for (const resourceUrl of getPerformanceResourceUrls()) {
			try {
				const parsed = new URL(resourceUrl);
				if (!/\/graphql\/[^/]+\/TweetResultByRestId$/i.test(parsed.pathname)) {
					continue;
				}
				const variables = JSON.parse(
					parsed.searchParams.get('variables') || '{}'
				) as { tweetId?: unknown };
				if (String(variables.tweetId || '') !== tweetId) continue;
				discovered.push(parsed.href);
			} catch {
				// Ignore unrelated or malformed performance entries.
			}
		}
		return Array.from(new Set(discovered));
	};
	const extractFromPerformance = (): XVideoCandidate[] =>
		getPerformanceResourceUrls()
			.filter(url => videoUrlPattern.test(url))
			.filter(url => !/\/aud\//i.test(url))
			.filter(url =>
				/\.m3u8(?:[?#]|$)/i.test(url) ||
				(
					/\.mp4(?:[?#]|$)/i.test(url) &&
					!/\/vid\/avc1\/\d+\/\d+\//i.test(url)
				)
			)
			.map((url): XVideoCandidate => {
				const sizeMatch = url.match(/\/(\d+)x(\d+)\//);
				const sizeScore = sizeMatch
					? Number(sizeMatch[1]) * Number(sizeMatch[2])
					: 0;
				return {
					id: url,
					url: normalizeVideoUrl(url),
					bitrate: sizeScore,
					contentType: /\.mp4(?:[?#]|$)/i.test(url)
						? 'video/mp4'
						: 'application/x-mpegURL',
					source: 'main-world-performance',
				};
			});
	const extractFromGraphql = async (): Promise<XVideoCandidate[]> => {
		const bearer = await getBearerToken();
		if (!bearer) return [];

		const features = {
			creator_subscriptions_tweet_preview_api_enabled: true,
			premium_content_api_read_enabled: false,
			communities_web_enable_tweet_community_results_fetch: true,
			c9s_tweet_anatomy_moderator_badge_enabled: true,
			responsive_web_grok_analyze_button_fetch_trends_enabled: false,
			responsive_web_grok_analyze_post_followups_enabled: true,
			rweb_cashtags_composer_attachment_enabled: true,
			responsive_web_jetfuel_frame: true,
			responsive_web_grok_share_attachment_enabled: true,
			responsive_web_grok_annotations_enabled: true,
			articles_preview_enabled: true,
			responsive_web_edit_tweet_api_enabled: true,
			rweb_conversational_replies_downvote_enabled: false,
			graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
			view_counts_everywhere_api_enabled: true,
			longform_notetweets_consumption_enabled: true,
			responsive_web_twitter_article_tweet_consumption_enabled: true,
			content_disclosure_indicator_enabled: true,
			content_disclosure_ai_generated_indicator_enabled: true,
			responsive_web_grok_show_grok_translated_post: true,
			responsive_web_grok_analysis_button_from_backend: true,
			post_ctas_fetch_enabled: false,
			rweb_cashtags_enabled: true,
			freedom_of_speech_not_reach_fetch_enabled: true,
			standardized_nudges_misinfo: true,
			tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
			longform_notetweets_rich_text_read_enabled: true,
			longform_notetweets_inline_media_enabled: false,
			profile_label_improvements_pcf_label_in_post_enabled: true,
			responsive_web_profile_redirect_enabled: true,
			rweb_tipjar_consumption_enabled: false,
			verified_phone_label_enabled: false,
			responsive_web_grok_image_annotation_enabled: true,
			responsive_web_grok_imagine_annotation_enabled: true,
			responsive_web_grok_community_note_auto_translation_is_enabled: true,
			responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
			responsive_web_graphql_timeline_navigation_enabled: true,
			responsive_web_enhance_cards_enabled: false,
		};
		const fieldToggles = {
			withArticleRichContentState: true,
			withArticlePlainText: false,
			withArticleSummaryText: true,
			withArticleVoiceOver: true,
			withGrokAnalyze: false,
			withDisallowedReplyControls: false,
		};
		const query = `?variables=${encodeURIComponent(JSON.stringify({
				tweetId,
				withCommunity: false,
				includePromotedContent: false,
				withVoice: false,
			}))}`
			+ `&features=${encodeURIComponent(JSON.stringify(features))}`
			+ `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
		const apiUrls = [
			...discoveredTweetResultUrls(),
			`https://x.com/i/api/graphql/4hhGRbehkcUVTKf8n0f0xw/TweetResultByRestId${query}`,
			`https://api.x.com/graphql/fHLDP3qFEjnTqhWBVvsREg/TweetResultByRestId${query}`,
		].filter((url, index, urls) => {
			try {
				const parsed = new URL(url);
				const key = `${parsed.origin}${parsed.pathname}`;
				return urls.findIndex(candidate => {
					try {
						const current = new URL(candidate);
						return `${current.origin}${current.pathname}` === key;
					} catch {
						return false;
					}
				}) === index;
			} catch {
				return false;
			}
		});
		const headers: Record<string, string> = {
			authorization: `Bearer ${bearer}`,
			'x-twitter-active-user': 'yes',
			'x-twitter-client-language': 'en',
		};
		const guestToken = getCookie('gt');
		const csrfToken = getCookie('ct0');
		if (guestToken) headers['x-guest-token'] = guestToken;
		if (csrfToken) headers['x-csrf-token'] = csrfToken;

		for (const apiUrl of apiUrls) {
			try {
				const controller = new AbortController();
				const timeout = window.setTimeout(() => controller.abort(), 1800);
				const response = await fetch(apiUrl, {
					credentials: 'include',
					headers,
					signal: controller.signal,
				}).finally(() => window.clearTimeout(timeout));
				if (!response.ok) continue;
				const data = await response.json();
				const mediaObjects = [
					...findTweetObjects(data).flatMap(tweet => collectMediaObjects(tweet)),
					...collectMediaObjects(data),
				];
				const graphqlCandidates = mediaObjects
					.map(fromMediaObject)
					.filter((candidate): candidate is XVideoCandidate => !!candidate)
					.map(candidate => ({
						...candidate,
						source: 'main-world-graphql',
					}));
				if (graphqlCandidates.length) return graphqlCandidates;
			} catch {
				// Try the next discovered or known TweetResult endpoint.
			}
		}
		return [];
	};

	const pageState = (window as typeof window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
	const candidates: XVideoCandidate[] = [];
	if (pageState) {
		candidates.push(...findTweetObjects(pageState)
			.flatMap(tweet => collectMediaObjects(tweet))
			.map(fromMediaObject)
			.filter((candidate): candidate is XVideoCandidate => !!candidate));
	}

	candidates.push(...extractFromPerformance());

	candidates.push(...await extractFromGraphql());
	candidates.push(...extractFromPerformance());
	for (let attempt = 0; attempt < 12 && candidates.length === 0; attempt++) {
		await new Promise(resolve => window.setTimeout(resolve, 250));
		candidates.push(...extractFromPerformance());
	}

	const sortedCandidates = sortCandidates(candidates);
	return {
		candidate: sortedCandidates[0] || null,
		candidates: sortedCandidates,
	};
}

export function registerXBackgroundHandlers(): PlatformBackgroundHandler[] {
	return [
		({ request, sender, sendResponse }) => {
			if (request.action !== 'xExtractVideoCandidate') return undefined;
			const tabId = typeof request.tabId === 'number' ? request.tabId : sender.tab?.id;
			const url = typeof request.url === 'string' ? request.url : sender.tab?.url || '';
			if (!tabId || !isXStatusUrl(url)) {
				sendResponse({ success: false, error: 'Invalid X tab.' });
				return true;
			}

			void (async () => {
				const syndicationCandidates = await extractXSyndicationVideoCandidates(url);
				if (syndicationCandidates.length) {
					sendResponse({
						success: true,
						candidate: syndicationCandidates[0],
						candidates: syndicationCandidates,
					});
					return;
				}

				try {
					const results = await chrome.scripting.executeScript({
						target: { tabId },
						world: 'MAIN',
						func: extractXVideoCandidateInMainWorld,
						args: [url],
					} as any) as Array<{ result?: unknown }>;
					const result = results[0]?.result as { candidate?: XVideoCandidate | null; candidates?: XVideoCandidate[] } | XVideoCandidate | null | undefined;
					if (result && 'candidates' in result) {
						sendResponse({ success: true, candidate: result.candidate || null, candidates: result.candidates || [] });
						return;
					}
					const candidate = result as XVideoCandidate | null | undefined;
					sendResponse({ success: true, candidate: candidate || null, candidates: candidate ? [candidate] : [] });
				} catch (error) {
					sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
				}
			})();
			return true;
		},
	];
}
