// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';

import browser from '../../utils/browser-polyfill';
import { appendXVideoFallback } from './extractor';

afterEach(() => {
	vi.restoreAllMocks();
	document.body.textContent = '';
});

describe('X video fallback', () => {
	test('inserts the direct MP4 returned by the background handler', async () => {
		const pageUrl = 'https://x.com/example/status/123456';
		document.body.innerHTML = `
			<article>
				<a href="/example/status/123456">Post</a>
				<div data-testid="tweetText">Video post</div>
				<div data-testid="videoPlayer">
					<video src="blob:https://x.com/local-video"
						poster="https://pbs.twimg.com/amplify_video_thumb/example/img/test.jpg"></video>
				</div>
			</article>
		`;
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			success: true,
			candidate: {
				id: 'media-id',
				poster: 'https://pbs.twimg.com/amplify_video_thumb/example/img/test.jpg',
				url: 'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4',
				bitrate: 2176000,
				contentType: 'video/mp4',
				source: 'syndication',
			},
			candidates: [
				{
					id: 'performance-master',
					url: 'https://video.twimg.com/amplify_video/media-id/pl/master.m3u8',
					contentType: 'application/x-mpegURL',
					source: 'performance',
				},
				{
					id: 'media-id',
					poster: 'https://pbs.twimg.com/amplify_video_thumb/example/img/test.jpg',
					url: 'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4',
					bitrate: 2176000,
					contentType: 'video/mp4',
					source: 'syndication',
				},
			],
		});

		const result = await appendXVideoFallback(
			'<article><p>Video post</p></article>',
			pageUrl,
			document
		);

		expect(result).toContain('data-obsidian-clipper-x-video="true"');
		expect(result).toContain(
			'https://video.twimg.com/amplify_video/media-id/vid/1280x720/high.mp4'
		);
		expect(result).not.toContain('.m3u8');
		expect(result).toContain('视频无法播放时：下载/打开原文件');
	});

	test('keeps an original-post link when every direct video probe returns empty', async () => {
		const pageUrl = 'https://x.com/example/status/123456';
		document.body.innerHTML = `
			<article>
				<a href="/example/status/123456">Post</a>
				<div data-testid="tweetText">Video post</div>
				<div data-testid="videoPlayer">
					<video src="blob:https://x.com/local-video"
						poster="https://pbs.twimg.com/amplify_video_thumb/example/img/test.jpg"></video>
				</div>
			</article>
		`;
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			success: true,
			candidate: null,
			candidates: [],
		});

		const result = await appendXVideoFallback(
			'<article><p>Video post</p></article>',
			pageUrl,
			document
		);

		expect(result).toContain('data-obsidian-clipper-x-video="true"');
		expect(result).toContain('X视频：打开原文播放');
		expect(result).toContain(pageUrl);
		expect(result).not.toContain('blob:');
	});
});
