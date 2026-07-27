// @vitest-environment jsdom

import {
	afterEach,
	describe,
	expect,
	test,
	vi,
} from 'vitest';

import {
	extractXSyndicationVideoCandidates,
	extractXVideoCandidateInMainWorld,
	registerXBackgroundHandlers,
} from './background';

const TWEET_ID = '2081279839684968757';
const PAGE_URL = `https://x.com/example/status/${TWEET_ID}`;
const FAKE_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgFAKE_TEST_TOKEN';

function installWebpackBearer(): void {
	(window as typeof window & {
		webpackChunk_twitter_responsive_web?: {
			push: (chunk: unknown[]) => void;
		};
	}).webpackChunk_twitter_responsive_web = {
		push(chunk) {
			const runtime = chunk[2] as (
				require: { m: Record<string, unknown> }
			) => void;
			runtime({
				m: {
					test: `function(){return "Bearer ${FAKE_BEARER}"}`,
				},
			});
		},
	};
}

function videoResponse() {
	return {
		data: {
			tweetResult: {
				result: {
					rest_id: TWEET_ID,
					legacy: {
						extended_entities: {
							media: [{
								id_str: 'media-id',
								type: 'video',
								media_url_https:
									'https://pbs.twimg.com/amplify_video_thumb/media-id/img/poster.jpg',
								video_info: {
									variants: [
										{
											content_type: 'application/x-mpegURL',
											url: 'https://video.twimg.com/amplify_video/media-id/pl/master.m3u8',
										},
										{
											bitrate: 832000,
											content_type: 'video/mp4',
											url: 'https://video.twimg.com/amplify_video/media-id/vid/640x360/medium.mp4',
										},
										{
											bitrate: 2176000,
											content_type: 'video/mp4',
											url: 'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4',
										},
									],
								},
							}],
						},
					},
				},
			},
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.head.innerHTML = '';
	document.body.innerHTML = '';
	delete (window as typeof window & {
		webpackChunk_twitter_responsive_web?: unknown;
	}).webpackChunk_twitter_responsive_web;
});

describe('X main-world video extraction', () => {
	test('uses the public X syndication response and selects the highest bitrate MP4', async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				mediaDetails: videoResponse()
					.data.tweetResult.result.legacy.extended_entities.media,
			}),
		})) as unknown as typeof fetch;

		const candidates = await extractXSyndicationVideoCandidates(PAGE_URL, fetchMock);

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('https://cdn.syndication.twimg.com/tweet-result?'),
			expect.objectContaining({
				credentials: 'omit',
			})
		);
		const requestUrl = new URL(String(
			(fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
		));
		expect(requestUrl.searchParams.get('id')).toBe(TWEET_ID);
		expect(requestUrl.searchParams.get('token')).toBeTruthy();
		expect(candidates[0]).toMatchObject({
			url: 'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4',
			bitrate: 2176000,
			contentType: 'video/mp4',
			source: 'syndication',
		});
		expect(candidates).toHaveLength(1);
	});

	test('returns the syndication candidate through the background message handler', async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				mediaDetails: videoResponse()
					.data.tweetResult.result.legacy.extended_entities.media,
			}),
		}));
		vi.stubGlobal('fetch', fetchMock);
		const executeScript = vi.fn();
		vi.stubGlobal('chrome', {
			scripting: { executeScript },
		});
		const sendResponse = vi.fn();
		const handler = registerXBackgroundHandlers()[0];

		const handled = handler({
			request: {
				action: 'xExtractVideoCandidate',
				url: PAGE_URL,
			},
			sender: {
				tab: {
					id: 42,
					url: PAGE_URL,
				},
			},
			sendResponse,
		} as any);
		await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

		expect(handled).toBe(true);
		expect(executeScript).not.toHaveBeenCalled();
		expect(sendResponse).toHaveBeenCalledWith({
			success: true,
			candidate: expect.objectContaining({
				url: 'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4',
				source: 'syndication',
			}),
			candidates: expect.arrayContaining([
				expect.objectContaining({
					url: 'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4',
				}),
			]),
		});
	});

	test('reuses the live TweetResult request and selects the highest bitrate MP4', async () => {
		installWebpackBearer();
		const liveRequestUrl =
			`https://x.com/i/api/graphql/current-query/TweetResultByRestId?variables=${
				encodeURIComponent(JSON.stringify({ tweetId: TWEET_ID }))
			}&features=%7B%7D`;
		vi.stubGlobal('performance', {
			getEntriesByType: () => [{ name: liveRequestUrl }],
		});
		const fetchMock = vi.fn(async (
			_input: RequestInfo | URL,
			_init?: RequestInit
		) => ({
			ok: true,
			json: async () => videoResponse(),
		}));
		vi.stubGlobal('fetch', fetchMock);

		const result = await extractXVideoCandidateInMainWorld(PAGE_URL);

		expect(fetchMock).toHaveBeenCalledWith(
			liveRequestUrl,
			expect.objectContaining({
				credentials: 'include',
				headers: expect.objectContaining({
					authorization: `Bearer ${FAKE_BEARER}`,
				}),
			})
		);
		expect(result.candidate).toMatchObject({
			url: 'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4',
			bitrate: 2176000,
			contentType: 'video/mp4',
			source: 'main-world-graphql',
		});
	});

	test('uses the current verified query when the page request is unavailable', async () => {
		installWebpackBearer();
		vi.stubGlobal('performance', {
			getEntriesByType: () => [],
		});
		const fetchMock = vi.fn(async (
			_input: RequestInfo | URL,
			_init?: RequestInit
		) => ({
			ok: true,
			json: async () => videoResponse(),
		}));
		vi.stubGlobal('fetch', fetchMock);

		const result = await extractXVideoCandidateInMainWorld(PAGE_URL);

		expect(String(fetchMock.mock.calls[0][0])).toContain(
			'/4hhGRbehkcUVTKf8n0f0xw/TweetResultByRestId'
		);
		expect(result.candidate?.url).toContain('/1280x720/high.mp4');
	});

	test('reads the bearer token from the current X main script when the old webpack global is absent', async () => {
		const script = document.createElement('script');
		script.src = 'https://abs.twimg.com/responsive-web/client-web/main.current.js';
		document.head.appendChild(script);
		const liveRequestUrl =
			`https://x.com/i/api/graphql/current-query/TweetResultByRestId?variables=${
				encodeURIComponent(JSON.stringify({ tweetId: TWEET_ID }))
			}&features=%7B%7D`;
		vi.stubGlobal('performance', {
			getEntriesByType: () => [{ name: liveRequestUrl }],
		});
		const fetchMock = vi.fn(async (
			input: RequestInfo | URL,
			_init?: RequestInit
		) => {
			if (String(input).includes('/responsive-web/client-web/main.')) {
				return {
					ok: true,
					text: async () => `const authorization = "Bearer ${FAKE_BEARER}";`,
				};
			}
			return {
				ok: true,
				json: async () => videoResponse(),
			};
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await extractXVideoCandidateInMainWorld(PAGE_URL);

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			script.src,
			expect.objectContaining({
				credentials: 'omit',
			})
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			liveRequestUrl,
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: `Bearer ${FAKE_BEARER}`,
				}),
			})
		);
		expect(result.candidate?.url).toContain('/1280x720/high.mp4');
	});

	test('ignores audio and adaptive fragments in the performance fallback', async () => {
		vi.stubGlobal('performance', {
			getEntriesByType: () => [
				{
					name: 'https://video.twimg.com/amplify_video/media-id/aud/mp4a/0/0/128000/audio.mp4',
				},
				{
					name: 'https://video.twimg.com/amplify_video/media-id/vid/avc1/0/3000/1280x720/fragment.mp4',
				},
				{
					name: 'https://video.twimg.com/amplify_video/media-id/pl/master.m3u8',
				},
			],
		});

		const result = await extractXVideoCandidateInMainWorld(PAGE_URL);

		expect(result.candidate).toMatchObject({
			url: 'https://video.twimg.com/amplify_video/media-id/pl/master.m3u8',
			contentType: 'application/x-mpegURL',
			source: 'main-world-performance',
		});
		expect(result.candidates).toHaveLength(1);
	});
});
