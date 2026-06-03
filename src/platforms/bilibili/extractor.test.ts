import { describe, expect, test } from 'vitest';

import {
	buildBilibiliEmbedHtml,
	buildBilibiliStructuredHtml,
} from './extractor';

describe('Bilibili extractor', () => {
	test('builds an Obsidian-playable Bilibili iframe', () => {
		const html = buildBilibiliEmbedHtml({
			aid: 123,
			bvid: 'BV13u411N7kr',
			cid: 456,
			page: 2,
		});

		expect(html).toContain('<iframe');
		expect(html).toContain('https://player.bilibili.com/player.html?');
		expect(html).toContain('aid=123');
		expect(html).toContain('bvid=BV13u411N7kr');
		expect(html).toContain('cid=456');
		expect(html).toContain('page=2');
		expect(html).toContain('autoplay=0');
		expect(html).toContain('aspect-ratio:16 / 9');
	});

	test('adds the video section before description content', () => {
		const html = buildBilibiliStructuredHtml({
			description: '视频简介',
			chapters: [],
			transcript: [],
			bvid: 'BV13u411N7kr',
			cid: 456,
			page: 1,
		});

		expect(html).toContain('class="bilibili-section bilibili-video"');
		expect(html.indexOf('bilibili-video')).toBeLessThan(html.indexOf('bilibili-description'));
		expect(html).toContain('player.bilibili.com/player.html?');
	});

	test('does not emit a broken iframe without a cid', () => {
		const html = buildBilibiliStructuredHtml({
			description: '视频简介',
			chapters: [],
			transcript: [],
			bvid: 'BV13u411N7kr',
			cid: null,
		});

		expect(html).not.toContain('<iframe');
		expect(html).toContain('视频简介');
	});
});
