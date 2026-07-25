import { afterEach, describe, expect, test, vi } from 'vitest';

import browser from '../../utils/browser-polyfill';
import { defaultPlatformSettings } from '../settings';
import { saveFeishuToObsidian } from './save';

afterEach(() => {
	vi.restoreAllMocks();
});

function useBridgeSettings(
	imageMode: 'links' | 'obsidian-bridge' = 'obsidian-bridge',
	attachmentMode: 'links' | 'obsidian-bridge' = 'obsidian-bridge'
) {
	vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
		platform_settings: {
			...defaultPlatformSettings,
			feishu: {
				...defaultPlatformSettings.feishu,
				imageMode,
				attachmentMode,
				bridgePairingToken: 'pairing-token',
			},
		},
	});
	vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({});
}

describe('Feishu Obsidian save hook', () => {
	test('delegates a bridge-marked note to the background transaction', async () => {
		useBridgeSettings();
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			success: true,
			data: {
				notePath: 'Inbox/Test.md',
				assetPaths: ['Attachments/image.png'],
			},
		});

		const result = await saveFeishuToObsidian({
			fileContent: '![封面](feishu-bridge://image/token-a)',
			noteName: 'Test',
			path: 'Inbox',
			vault: 'My Vault',
			behavior: 'create',
			url: 'https://tenant.feishu.cn/docx/example',
		});

		expect(result).toMatchObject({
			handled: true,
			notePath: 'Inbox/Test.md',
		});
		expect(sendMessage).toHaveBeenCalledWith({
			action: 'saveFeishuWithBridge',
			input: expect.objectContaining({
				notePath: 'Inbox/Test',
				behavior: 'create',
				vault: 'My Vault',
			}),
		});
	});

	test('falls back to portable source links for daily notes', async () => {
		useBridgeSettings();
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

		const result = await saveFeishuToObsidian({
			fileContent: [
				'![封面](feishu-bridge://image/token-a)',
				'![图片附件](feishu-bridge://image-file/image-file-token)',
				'![演示视频](feishu-bridge://video/video-token)',
				'[资料包](feishu-bridge://file/file-token)',
			].join('\n'),
			noteName: '',
			path: '',
			vault: 'My Vault',
			behavior: 'append-daily',
			url: 'https://tenant.feishu.cn/docx/example',
		});

		expect(result).toEqual({
			handled: false,
			fileContent: [
				'[封面](https://tenant.feishu.cn/docx/example)',
				'[图片附件](https://tenant.feishu.cn/docx/example)',
				'[演示视频](https://tenant.feishu.cn/docx/example)',
				'[资料包](https://tenant.feishu.cn/docx/example)',
			].join('\n'),
		});
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test('delegates video-only bridge notes when images stay linked', async () => {
		useBridgeSettings('links', 'obsidian-bridge');
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			success: true,
			data: {
				notePath: 'Inbox/Video.md',
				assetPaths: ['Attachments/video.mp4'],
			},
		});

		const result = await saveFeishuToObsidian({
			fileContent: '![演示视频](feishu-bridge://video/video-token)',
			noteName: 'Video',
			path: 'Inbox',
			vault: 'My Vault',
			behavior: 'create',
			url: 'https://tenant.feishu.cn/docx/example',
		});

		expect(result).toMatchObject({
			handled: true,
			notePath: 'Inbox/Video.md',
		});
		expect(sendMessage).toHaveBeenCalledOnce();
	});
});
