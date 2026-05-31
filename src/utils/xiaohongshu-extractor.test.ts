import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import {
	extractXiaohongshuNoteFromHtml,
	extractXiaohongshuNoteFromDocument,
	isXiaohongshuNoteUrl,
	normalizeXiaohongshuUrl,
} from './xiaohongshu-extractor';

function buildHtml(note: any): string {
	return `
		<html>
			<head><title>${note.title || '小红书笔记'} - 小红书</title></head>
			<body>
				<script>window.__INITIAL_STATE__=${JSON.stringify({
					note: {
						noteDetailMap: {
							[note.noteId || 'abc123']: {
								note,
							},
						},
					},
				})}</script>
			</body>
		</html>
	`;
}

describe('Xiaohongshu extractor', () => {
	test('detects note URLs and normalizes explore URLs', () => {
		expect(isXiaohongshuNoteUrl('https://www.xiaohongshu.com/explore/abc123?xsec_token=token')).toBe(true);
		expect(isXiaohongshuNoteUrl('https://www.xiaohongshu.com/discovery/item/abc123')).toBe(true);
		expect(isXiaohongshuNoteUrl('http://xhslink.com/a/abc')).toBe(true);
		expect(isXiaohongshuNoteUrl('https://example.com/explore/abc123')).toBe(false);
		expect(normalizeXiaohongshuUrl('https://www.xiaohongshu.com/explore/abc123?x=1'))
			.toBe('https://www.xiaohongshu.com/discovery/item/abc123?x=1');
	});

	test('extracts images, tags, author and description from initial state', () => {
		const html = buildHtml({
			noteId: 'note1',
			title: '上海咖啡地图',
			desc: '第一行\n第二行 #咖啡 #上海[话题]',
			type: 'normal',
			time: 1712046600,
			user: { nickname: '不叫小黄了' },
			tagList: [{ name: '探店' }],
			imageList: [
				{ urlDefault: 'https://ci.xiaohongshu.com/image-a' },
				{ infoList: [{ url: 'https://ci.xiaohongshu.com/image-b' }] },
			],
		});

		const result = extractXiaohongshuNoteFromHtml(html, 'https://www.xiaohongshu.com/explore/note1');

		expect(result?.title).toBe('上海咖啡地图');
		expect(result?.author).toBe('不叫小黄了');
		expect(result?.description).toContain('第一行');
		expect(result?.tags).toEqual(['探店', '咖啡', '上海']);
		expect(result?.images).toEqual([
			'https://ci.xiaohongshu.com/image-a',
			'https://ci.xiaohongshu.com/image-b',
		]);
		expect(result?.structuredHtml).toContain('<img src="https://ci.xiaohongshu.com/image-a"');
		expect(result?.structuredHtml).toContain('打开小红书原文');
	});

	test('extracts video URL when note has stream metadata', () => {
		const html = buildHtml({
			noteId: 'video1',
			title: '做饭视频',
			desc: '晚餐记录',
			type: 'video',
			video: {
				media: {
					stream: {
						h264: [{ masterUrl: 'https://sns-video-hw.xhscdn.com/video.mp4' }],
					},
				},
			},
		});

		const result = extractXiaohongshuNoteFromHtml(html, 'https://www.xiaohongshu.com/discovery/item/video1');

		expect(result?.type).toBe('video');
		expect(result?.videoUrl).toBe('https://sns-video-hw.xhscdn.com/video.mp4');
		expect(result?.structuredHtml).toContain('<video controls preload="metadata" src="https://sns-video-hw.xhscdn.com/video.mp4"');
	});

	test('extracts video URL from mediaV2 snake case stream metadata', () => {
		const html = buildHtml({
			noteId: 'video2',
			title: '主持人视频',
			desc: '视频正文',
			type: 'video',
			video: {
				mediaV2: JSON.stringify({
					stream: {
						h264: [{
							master_url: 'https://sns-video-zl.xhscdn.com/stream_glo/video_259.mp4',
							backup_urls: ['https://sns-bak-v8.xhscdn.com/stream_glo/video_259.mp4'],
						}],
					},
				}),
			},
			imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/cover.webp' }],
		});

		const result = extractXiaohongshuNoteFromHtml(html, 'https://www.xiaohongshu.com/explore/video2');

		expect(result?.type).toBe('video');
		expect(result?.videoUrl).toBe('https://sns-video-zl.xhscdn.com/stream_glo/video_259.mp4');
		expect(result?.structuredHtml.indexOf('<video')).toBeLessThan(result!.structuredHtml.indexOf('<img'));
		expect(result?.structuredHtml).toContain('style="display:block;max-width:100%;height:auto;width:100%;"');
	});

	test('extracts the provided real-world video note shape', () => {
		const html = buildHtml({
			noteId: '6a007a190000000013020402',
			title: '很开心担任赵露思曼谷演唱会主持人💜',
			desc: '非常开心能够担任赵露思曼谷演唱会的主持人。#赵露思 #rosyzhao',
			type: 'video',
			user: { nickname: '泰国装小妹' },
			video: {
				media: {
					stream: {
						h264: [{
							masterUrl: 'http://sns-video-zl.xhscdn.com/stream_glo/10001/110/259/0aea0079bb1a64850103700370039e11df5388_259.mp4?sign=test',
						}],
					},
				},
			},
			imageList: [{ urlDefault: 'http://sns-webpic-qc.xhscdn.com/oss-sg/notes/cover!nd_dft_wlteh_webp_3' }],
		});

		const result = extractXiaohongshuNoteFromHtml(
			html,
			'https://www.xiaohongshu.com/explore/6a007a190000000013020402?xsec_token=AB8-jE6vq2aq1dY0Xni2FxuJDDkroJBL71YkNFiuOAXjw=&xsec_source=pc_feed'
		);

		expect(result?.noteId).toBe('6a007a190000000013020402');
		expect(result?.author).toBe('泰国装小妹');
		expect(result?.type).toBe('video');
		expect(result?.videoUrl).toContain('sns-video-zl.xhscdn.com/stream_glo');
		expect(result?.images).toHaveLength(1);
		expect(result?.structuredHtml).toContain('<video controls');
	});

	test('works with a parsed document outerHTML fixture', () => {
		const { document } = parseHTML(buildHtml({
			noteId: 'note2',
			title: '标题',
			desc: '正文',
			imageList: [{ urlDefault: 'https://ci.xiaohongshu.com/a' }],
		}));

		const result = extractXiaohongshuNoteFromHtml(
			(document as unknown as Document).documentElement.outerHTML,
			'https://www.xiaohongshu.com/explore/note2'
		);

		expect(result?.image).toBe('https://ci.xiaohongshu.com/a');
	});

	test('falls back to the hydrated Xiaohongshu note detail DOM', () => {
		const { document } = parseHTML(`
			<html>
				<head><title>35-45岁失业，千万不要放弃这5项长期资产❗ - 小红书</title></head>
				<body>
					<div id="noteContainer" note-id="6a0eea1e000000003501ce70" data-type="normal">
						<div class="author-wrapper"><a class="name">职场人成长计划</a></div>
						<div id="detail-title">35-45岁失业，千万不要放弃这5项长期资产❗</div>
						<div id="detail-desc">
							<a class="tag">#职场个人提升</a>
							<a id="hash-tag">#中年失业</a>
							<span>正文内容</span>
						</div>
						<img class="avatar-item" src="https://sns-avatar-qc.xhscdn.com/avatar/a.jpg">
						<img data-xhs-img src="https://sns-webpic-qc.xhscdn.com/notes_pre_post/a!nd_dft_wlteh_webp_3">
						<img data-xhs-img src="https://sns-webpic-qc.xhscdn.com/notes_pre_post/b!nd_dft_wlteh_webp_3">
					</div>
				</body>
			</html>
		`);

		const result = extractXiaohongshuNoteFromDocument(
			document as unknown as Document,
			'https://www.xiaohongshu.com/explore/6a0eea1e000000003501ce70'
		);

		expect(result?.noteId).toBe('6a0eea1e000000003501ce70');
		expect(result?.author).toBe('职场人成长计划');
		expect(result?.tags).toEqual(['职场个人提升', '中年失业']);
		expect(result?.images).toEqual([
			'https://sns-webpic-qc.xhscdn.com/notes_pre_post/a!nd_dft_wlteh_webp_3',
			'https://sns-webpic-qc.xhscdn.com/notes_pre_post/b!nd_dft_wlteh_webp_3',
		]);
		expect(result?.structuredHtml).toContain('正文内容');
	});
});
