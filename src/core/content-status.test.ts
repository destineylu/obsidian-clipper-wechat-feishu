import { describe, expect, test } from 'vitest';
import { countNoteContentMedia } from './content-status';

describe('note content media status', () => {
	test('counts Feishu images separately from videos and attachments', () => {
		const images = Array.from(
			{ length: 29 },
			(_, index) =>
				`![图片 ${index + 1}](feishu-bridge://image/image-${index + 1})`
		);
		const videos = Array.from(
			{ length: 26 },
			(_, index) =>
				`![视频 ${index + 1}](feishu-bridge://video/video-${index + 1})`
		);

		expect(countNoteContentMedia([...images, ...videos].join('\n')))
			.toEqual({
				imageCount: 29,
				bridgeAttachmentCount: 26,
				mediaLinkCount: 0,
			});
	});

	test('counts linked images, bridge files, and legacy media links', () => {
		const content = [
			'![普通图片](https://example.com/image.png)',
			'[飞书图片未内联](https://example.com/image)',
			'[资料包](feishu-bridge://file/file-token)',
			'[微信视频](https://example.com/video)',
		].join('\n');

		expect(countNoteContentMedia(content)).toEqual({
			imageCount: 2,
			bridgeAttachmentCount: 1,
			mediaLinkCount: 1,
		});
	});
});
