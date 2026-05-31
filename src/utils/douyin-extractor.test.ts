import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import {
	extractDouyinAwemeFromDocument,
	extractDouyinAwemeFromHtml,
	isDouyinAwemeUrl,
	normalizeDouyinUrl,
} from './douyin-extractor';

function buildRouterHtml(aweme: any): string {
	return `
		<html>
			<head><title>${aweme.desc || '抖音作品'} - 抖音</title></head>
			<body>
				<script>window._ROUTER_DATA=${JSON.stringify({
					loaderData: {
						video: {
							aweme,
						},
					},
				})};</script>
			</body>
		</html>
	`;
}

function buildRenderDataHtml(aweme: any): string {
	return `
		<html>
			<head><title>抖音作品</title></head>
			<body>
				<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify({
					app: {
						awemeDetail: aweme,
					},
				}))}</script>
			</body>
		</html>
	`;
}

describe('Douyin extractor', () => {
	test('detects and normalizes Douyin aweme URLs', () => {
		expect(isDouyinAwemeUrl('https://www.douyin.com/video/7400000000000000000')).toBe(true);
		expect(isDouyinAwemeUrl('https://www.douyin.com/note/7400000000000000000')).toBe(true);
		expect(isDouyinAwemeUrl('https://www.iesdouyin.com/share/video/7400000000000000000/')).toBe(true);
		expect(isDouyinAwemeUrl('https://v.douyin.com/abc123/')).toBe(true);
		expect(isDouyinAwemeUrl('https://example.com/video/7400000000000000000')).toBe(false);
		expect(normalizeDouyinUrl('https://www.iesdouyin.com/share/video/7400000000000000000/?region=CN'))
			.toBe('https://www.douyin.com/video/7400000000000000000');
	});

	test('extracts video, author and description from router data', () => {
		const html = buildRouterHtml({
			aweme_id: '7400000000000000000',
			desc: '今天的城市散步 #生活',
			create_time: 1712046600,
			author: { nickname: '散步的人' },
			video: {
				cover: { url_list: ['https://p3-douyinpic.com/tos-cn-i-cover.jpeg'] },
				play_addr: {
					url_list: [
						'https://www.douyin.com/aweme/v1/play/?video_id=v0200fg10000&mime_type=video_mp4',
					],
				},
				bit_rate: [{
					bit_rate: 1200,
					play_addr: {
						url_list: ['https://v3-dy-o.zjcdn.com/tos-cn-ve-15/o0/video.mp4?test=1'],
					},
				}],
			},
		});

		const result = extractDouyinAwemeFromHtml(html, 'https://www.douyin.com/video/7400000000000000000');

		expect(result?.awemeId).toBe('7400000000000000000');
		expect(result?.author).toBe('散步的人');
		expect(result?.description).toContain('城市散步');
		expect(result?.videoUrl).toBe('https://v3-dy-o.zjcdn.com/tos-cn-ve-15/o0/video.mp4?test=1');
		expect(result?.image).toBe('https://p3-douyinpic.com/tos-cn-i-cover.jpeg');
		expect(result?.structuredHtml).toContain('<video controls preload="metadata"');
		expect(result?.structuredHtml).toContain('打开抖音原文');
	});

	test('extracts image post data from encoded RENDER_DATA', () => {
		const html = buildRenderDataHtml({
			aweme_id: '7500000000000000000',
			desc: '图文旅行记录',
			author: { nickname: '旅行者' },
			image_post_info: {
				images: [
					{ display_image: { url_list: ['https://p3-douyinpic.com/img/a.webp'] } },
					{ origin_image: { url_list: ['https://p9-douyinpic.com/img/b.jpeg'] } },
				],
			},
		});

		const result = extractDouyinAwemeFromHtml(html, 'https://www.douyin.com/note/7500000000000000000');

		expect(result?.type).toBe('image');
		expect(result?.images).toEqual([
			'https://p3-douyinpic.com/img/a.webp',
			'https://p9-douyinpic.com/img/b.jpeg',
		]);
		expect(result?.structuredHtml).toContain('<section class="douyin-images">');
		expect(result?.structuredHtml).not.toContain('<video');
	});

	test('falls back to document meta and rendered media', () => {
		const { document } = parseHTML(`
			<html>
				<head>
					<title>备用标题 - 抖音</title>
					<meta property="og:description" content="备用文案">
					<meta property="og:title" content="备用标题">
				</head>
				<body>
					<video src="https://v3-dy-o.zjcdn.com/tos-cn-ve-15/o0/fallback.mp4"></video>
					<img src="https://p3-douyinpic.com/img/fallback.webp">
					<img src="https://p3-douyinpic.com/avatar/avatar.webp">
				</body>
			</html>
		`);

		const result = extractDouyinAwemeFromDocument(
			document as unknown as Document,
			'https://www.douyin.com/video/7600000000000000000'
		);

		expect(result?.title).toBe('备用标题');
		expect(result?.description).toBe('备用文案');
		expect(result?.videoUrl).toBe('https://v3-dy-o.zjcdn.com/tos-cn-ve-15/o0/fallback.mp4');
		expect(result?.images).toEqual(['https://p3-douyinpic.com/img/fallback.webp']);
	});
});
