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

function isXStatusUrl(url: string): boolean {
	return X_STATUS_PATTERN.test(url);
}

async function extractXVideoCandidateInMainWorld(pageUrl: string): Promise<XVideoCandidate | null> {
	const tweetId = pageUrl.match(/^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i)?.[1] || '';
	if (!tweetId) return null;

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
	const chooseBest = (candidates: XVideoCandidate[]): XVideoCandidate | null => {
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
		})[0] || null;
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
		const videoInfo = media.video_info;
		if (!isObject(videoInfo) || !Array.isArray(videoInfo.variants)) return null;
		const variant = (videoInfo.variants as Array<{ bitrate?: number; content_type?: string; url?: string }>)
			.filter(item => item.url && videoUrlPattern.test(item.url))
			.sort((left, right) => {
				const leftIsMp4 = left.content_type === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(left.url || '');
				const rightIsMp4 = right.content_type === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(right.url || '');
				if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
				return (right.bitrate || 0) - (left.bitrate || 0);
			})[0];
		if (!variant?.url) return null;
		return {
			id: String(media.id_str || media.media_key || variant.url),
			poster: typeof media.media_url_https === 'string' ? media.media_url_https : undefined,
			url: normalizeVideoUrl(variant.url),
			bitrate: variant.bitrate,
			contentType: variant.content_type,
			source: 'main-world-initial-state',
		};
	};
	const getCookie = (name: string): string => {
		const value = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1] || '';
		return decodeURIComponent(value);
	};
	const getBearerToken = (): string => {
		try {
			let webpackRequire: { m?: Record<string, unknown> } | undefined;
			(window as typeof window & { webpackChunk_twitter_responsive_web?: unknown[] })
				.webpackChunk_twitter_responsive_web
				?.push([[Math.random()], {}, (require: { m?: Record<string, unknown> }) => {
					webpackRequire = require;
				}]);

			const moduleSources = Object.values(webpackRequire?.m || {}).map(moduleFactory => String(moduleFactory));
			for (const source of moduleSources) {
				const match = source.match(/Bearer (AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]+)/);
				if (match?.[1]?.includes('NRILg')) return decodeURIComponent(match[1]);
			}
			for (const source of moduleSources) {
				const match = source.match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]+)"/);
				if (match?.[1]?.includes('NRILg')) return decodeURIComponent(match[1]);
			}
		} catch {
			// X changes the webpack runtime occasionally; fall back to DOM-only probes.
		}
		return '';
	};
	const extractFromGraphql = async (): Promise<XVideoCandidate[]> => {
		const bearer = getBearerToken();
		if (!bearer) return [];

		const features = {
			creator_subscriptions_tweet_preview_api_enabled: true,
			premium_content_api_read_enabled: false,
			communities_web_enable_tweet_community_results_fetch: true,
			c9s_tweet_anatomy_moderator_badge_enabled: true,
			responsive_web_grok_analyze_button_fetch_trends_enabled: false,
			responsive_web_grok_analyze_post_followups_enabled: false,
			responsive_web_jetfuel_frame: true,
			responsive_web_grok_share_attachment_enabled: true,
			responsive_web_grok_annotations_enabled: true,
			articles_preview_enabled: true,
			responsive_web_edit_tweet_api_enabled: true,
			graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
			view_counts_everywhere_api_enabled: true,
			longform_notetweets_consumption_enabled: true,
			responsive_web_twitter_article_tweet_consumption_enabled: true,
			content_disclosure_indicator_enabled: true,
			content_disclosure_ai_generated_indicator_enabled: true,
			responsive_web_grok_show_grok_translated_post: true,
			responsive_web_grok_analysis_button_from_backend: true,
			post_ctas_fetch_enabled: true,
			rweb_cashtags_enabled: true,
			freedom_of_speech_not_reach_fetch_enabled: true,
			standardized_nudges_misinfo: true,
			tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
			longform_notetweets_rich_text_read_enabled: true,
			longform_notetweets_inline_media_enabled: false,
			profile_label_improvements_pcf_label_in_post_enabled: true,
			responsive_web_profile_redirect_enabled: false,
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
		const apiUrl = 'https://api.x.com/graphql/fHLDP3qFEjnTqhWBVvsREg/TweetResultByRestId'
			+ `?variables=${encodeURIComponent(JSON.stringify({
				tweetId,
				withCommunity: false,
				includePromotedContent: false,
				withVoice: false,
			}))}`
			+ `&features=${encodeURIComponent(JSON.stringify(features))}`
			+ `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
		const headers: Record<string, string> = {
			authorization: `Bearer ${bearer}`,
			'x-twitter-active-user': 'yes',
			'x-twitter-client-language': 'en',
		};
		const guestToken = getCookie('gt');
		const csrfToken = getCookie('ct0');
		if (guestToken) headers['x-guest-token'] = guestToken;
		if (csrfToken) headers['x-csrf-token'] = csrfToken;

		try {
			const controller = new AbortController();
			const timeout = window.setTimeout(() => controller.abort(), 8000);
			const response = await fetch(apiUrl, {
				credentials: 'include',
				headers,
				signal: controller.signal,
			}).finally(() => window.clearTimeout(timeout));
			if (!response.ok) return [];
			const data = await response.json();
			const mediaObjects = [
				...findTweetObjects(data).flatMap(tweet => collectMediaObjects(tweet)),
				...collectMediaObjects(data),
			];
			return mediaObjects
				.map(fromMediaObject)
				.filter((candidate): candidate is XVideoCandidate => !!candidate)
				.map(candidate => ({ ...candidate, source: 'main-world-graphql' }));
		} catch {
			return [];
		}
	};

	const pageState = (window as typeof window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
	const candidates: XVideoCandidate[] = [];
	if (pageState) {
		candidates.push(...findTweetObjects(pageState)
			.flatMap(tweet => collectMediaObjects(tweet))
			.map(fromMediaObject)
			.filter((candidate): candidate is XVideoCandidate => !!candidate));
	}

	candidates.push(...performance.getEntriesByType('resource')
		.map(entry => entry.name)
		.filter(url => videoUrlPattern.test(url))
		.map((url): XVideoCandidate => {
			const sizeMatch = url.match(/\/(\d+)x(\d+)\//);
			const sizeScore = sizeMatch ? Number(sizeMatch[1]) * Number(sizeMatch[2]) : 0;
			return {
				id: url,
				url: normalizeVideoUrl(url),
				bitrate: sizeScore,
				contentType: /\.mp4(?:[?#]|$)/i.test(url) ? 'video/mp4' : 'application/x-mpegURL',
				source: 'main-world-performance',
			};
		}));

	if (!candidates.length) {
		candidates.push(...await extractFromGraphql());
	}

	return chooseBest(candidates);
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

			chrome.scripting.executeScript({
				target: { tabId },
				world: 'MAIN',
				func: async (targetUrl: string) => {
					const tweetId = targetUrl.match(/^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i)?.[1] || '';
					if (!tweetId) return null;
					let webpackRequire: { m?: Record<string, unknown> } | undefined;
					(window as typeof window & { webpackChunk_twitter_responsive_web?: unknown[] })
						.webpackChunk_twitter_responsive_web
						?.push([[Math.random()], {}, (require: { m?: Record<string, unknown> }) => {
							webpackRequire = require;
						}]);
					const moduleSources = Object.values(webpackRequire?.m || {}).map(moduleFactory => String(moduleFactory));
					let bearer = '';
					for (const source of moduleSources) {
						const match = source.match(/Bearer (AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]+)/);
						if (match?.[1]?.includes('NRILg')) {
							bearer = decodeURIComponent(match[1]);
							break;
						}
					}
					if (!bearer) {
						for (const source of moduleSources) {
							const match = source.match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]+)"/);
							if (match?.[1]?.includes('NRILg')) {
								bearer = decodeURIComponent(match[1]);
								break;
							}
						}
					}
					if (!bearer) return null;
					const cookie = (name: string) => decodeURIComponent(document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1] || '');
					const features = {
						creator_subscriptions_tweet_preview_api_enabled: true,
						premium_content_api_read_enabled: false,
						communities_web_enable_tweet_community_results_fetch: true,
						c9s_tweet_anatomy_moderator_badge_enabled: true,
						responsive_web_grok_analyze_button_fetch_trends_enabled: false,
						responsive_web_grok_analyze_post_followups_enabled: false,
						responsive_web_jetfuel_frame: true,
						responsive_web_grok_share_attachment_enabled: true,
						responsive_web_grok_annotations_enabled: true,
						articles_preview_enabled: true,
						responsive_web_edit_tweet_api_enabled: true,
						graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
						view_counts_everywhere_api_enabled: true,
						longform_notetweets_consumption_enabled: true,
						responsive_web_twitter_article_tweet_consumption_enabled: true,
						content_disclosure_indicator_enabled: true,
						content_disclosure_ai_generated_indicator_enabled: true,
						responsive_web_grok_show_grok_translated_post: true,
						responsive_web_grok_analysis_button_from_backend: true,
						post_ctas_fetch_enabled: true,
						rweb_cashtags_enabled: true,
						freedom_of_speech_not_reach_fetch_enabled: true,
						standardized_nudges_misinfo: true,
						tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
						longform_notetweets_rich_text_read_enabled: true,
						longform_notetweets_inline_media_enabled: false,
						profile_label_improvements_pcf_label_in_post_enabled: true,
						responsive_web_profile_redirect_enabled: false,
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
					const apiUrl = 'https://api.x.com/graphql/fHLDP3qFEjnTqhWBVvsREg/TweetResultByRestId'
						+ `?variables=${encodeURIComponent(JSON.stringify({ tweetId, withCommunity: false, includePromotedContent: false, withVoice: false }))}`
						+ `&features=${encodeURIComponent(JSON.stringify(features))}`
						+ `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
					const headers: Record<string, string> = {
						authorization: `Bearer ${bearer}`,
						'x-twitter-active-user': 'yes',
						'x-twitter-client-language': 'en',
					};
					const guestToken = cookie('gt');
					const csrfToken = cookie('ct0');
					if (guestToken) headers['x-guest-token'] = guestToken;
					if (csrfToken) headers['x-csrf-token'] = csrfToken;
					const controller = new AbortController();
					const timeout = window.setTimeout(() => controller.abort(), 8000);
					let data: unknown;
					try {
						const response = await fetch(apiUrl, { credentials: 'include', headers, signal: controller.signal });
						if (!response.ok) return null;
						data = await response.json();
					} finally {
						window.clearTimeout(timeout);
					}
					const seen = new Set<unknown>();
					const stack: unknown[] = [data];
					const candidates: Array<{ id: string; poster?: string; url: string; bitrate?: number; contentType?: string; source: string }> = [];
					while (stack.length) {
						const current = stack.pop();
						if (!current || typeof current !== 'object' || seen.has(current)) continue;
						seen.add(current);
						const object = current as Record<string, unknown>;
						const videoInfo = object.video_info as Record<string, unknown> | undefined;
						if (videoInfo && Array.isArray(videoInfo.variants)) {
							for (const variant of videoInfo.variants as Array<{ bitrate?: number; content_type?: string; url?: string }>) {
								if (!variant.url || !/^https:\/\/video\.twimg\.com\/.+\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(variant.url)) continue;
								candidates.push({
									id: String(object.id_str || object.media_key || variant.url),
									poster: typeof object.media_url_https === 'string' ? object.media_url_https : undefined,
									url: variant.url,
									bitrate: variant.bitrate,
									contentType: variant.content_type,
									source: 'main-world-graphql-inline',
								});
							}
						}
						for (const value of Object.values(object)) {
							if (value && typeof value === 'object') stack.push(value);
						}
					}
					return candidates.sort((left, right) => {
						const leftIsMp4 = left.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(left.url);
						const rightIsMp4 = right.contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(right.url);
						if (leftIsMp4 !== rightIsMp4) return leftIsMp4 ? -1 : 1;
						return (right.bitrate || 0) - (left.bitrate || 0);
					})[0] || null;
				},
				args: [url],
			} as any).then((results: Array<{ result?: unknown }>) => {
				const candidate = results[0]?.result as XVideoCandidate | null | undefined;
				sendResponse({ success: true, candidate: candidate || null });
			}).catch((error) => {
				sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
			});
			return true;
		},
	];
}
