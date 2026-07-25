// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';

import browser from '../../utils/browser-polyfill';
import { defaultPlatformSettings } from '../settings';
import { processFeishuMarkdown } from './markdown';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Feishu Markdown image modes', () => {
	test('keeps image tokens as bridge markers without downloading Base64', async () => {
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			platform_settings: {
				...defaultPlatformSettings,
				feishu: {
					...defaultPlatformSettings.feishu,
					imageMode: 'obsidian-bridge',
					attachmentMode: 'obsidian-bridge',
					bridgePairingToken: 'configured',
				},
			},
		});
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({});

		const fallbackUrl = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/token-a?policy=test';
		const result = await processFeishuMarkdown(
			`<figure><img src="feishu-image://token-a?fallback=${encodeURIComponent(fallbackUrl)}" alt="封面"></figure>`,
			'https://tenant.feishu.cn/docx/example'
		);

		expect(result?.markdownBody).toContain(
			`![封面](feishu-bridge://image/token-a?fallback=${encodeURIComponent(fallbackUrl)})`
		);
		expect(result?.markdownBody).not.toContain('data:image/');
		expect(result?.markdownBody).not.toContain('Feishu图片未内联');
		expect(result?.debugInfo).toMatchObject({
			feishuMediaInliningPolicy: 'bridge',
			feishuImageMode: 'obsidian-bridge',
		});
	});

	test('converts video and file placeholders into typed bridge markers', async () => {
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			platform_settings: {
				...defaultPlatformSettings,
				feishu: {
					...defaultPlatformSettings.feishu,
					imageMode: 'obsidian-bridge',
					attachmentMode: 'obsidian-bridge',
					bridgePairingToken: 'configured',
				},
			},
		});
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({});

		const result = await processFeishuMarkdown([
			'<figure><video src="feishu-file://video-token"></video><figcaption>演示视频</figcaption></figure>',
			'<p><a href="feishu-file://file-token">资料包</a></p>',
		].join(''), 'https://tenant.feishu.cn/docx/example');

		expect(result?.markdownBody).toContain(
			'![演示视频](feishu-bridge://video/video-token)'
		);
		expect(result?.markdownBody).toContain(
			'[资料包](feishu-bridge://file/file-token)'
		);
		expect(result?.markdownBody).not.toContain('打开原飞书文档');
	});

	test('stores images locally while keeping videos and large attachments as links', async () => {
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			platform_settings: {
				...defaultPlatformSettings,
				feishu: {
					...defaultPlatformSettings.feishu,
					imageMode: 'obsidian-bridge',
					attachmentMode: 'links',
					bridgePairingToken: 'configured',
				},
			},
		});
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({});

		const result = await processFeishuMarkdown([
			'<figure><img src="feishu-image://image-token" alt="封面"></figure>',
			'<figure><video src="feishu-file://video-token"></video><figcaption>演示视频</figcaption></figure>',
			'<p><a href="feishu-file://file-token">资料包</a></p>',
		].join(''), 'https://tenant.feishu.cn/docx/example');

		expect(result?.markdownBody).toContain(
			'![封面](feishu-bridge://image/image-token)'
		);
		expect(result?.markdownBody).not.toContain('feishu-bridge://video/');
		expect(result?.markdownBody).not.toContain('feishu-bridge://file/');
		expect(result?.markdownBody).toContain('演示视频：打开原飞书文档');
		expect(result?.markdownBody).toContain(
			'[资料包](https://tenant.feishu.cn/docx/example)'
		);
		expect(result?.debugInfo).toMatchObject({
			feishuImageMode: 'obsidian-bridge',
			feishuAttachmentMode: 'links',
		});
	});

	test('keeps images as links while storing videos and large attachments locally', async () => {
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			platform_settings: {
				...defaultPlatformSettings,
				feishu: {
					...defaultPlatformSettings.feishu,
					imageMode: 'links',
					attachmentMode: 'obsidian-bridge',
					bridgePairingToken: 'configured',
				},
			},
		});
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({});

		const result = await processFeishuMarkdown([
			'<figure><img src="feishu-image://image-token" alt="封面"></figure>',
			'<figure><video src="feishu-file://video-token"></video><figcaption>演示视频</figcaption></figure>',
			'<p><a href="feishu-file://file-token">资料包</a></p>',
		].join(''), 'https://tenant.feishu.cn/docx/example');

		expect(result?.markdownBody).not.toContain('feishu-bridge://image/');
		expect(result?.markdownBody).toContain('Feishu图片未内联');
		expect(result?.markdownBody).toContain(
			'![演示视频](feishu-bridge://video/video-token)'
		);
		expect(result?.markdownBody).toContain(
			'[资料包](feishu-bridge://file/file-token)'
		);
		expect(result?.debugInfo).toMatchObject({
			feishuImageMode: 'links',
			feishuAttachmentMode: 'obsidian-bridge',
		});
	});
});
