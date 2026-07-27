import { afterEach, describe, expect, test, vi } from 'vitest';

import browser from '../../utils/browser-polyfill';
import { defaultPlatformSettings } from '../settings';
import { saveFeishuToObsidian } from './save';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
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
		vi.stubGlobal('confirm', vi.fn(() => true));
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

	test('keeps video links when the user declines a large attachment download', async () => {
		useBridgeSettings();
		const confirmDownload = vi.fn(() => false);
		vi.stubGlobal('confirm', confirmDownload);
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			success: true,
			data: {
				notePath: 'Inbox/Mixed.md',
				assetPaths: ['Attachments/image.png'],
			},
		});

		await saveFeishuToObsidian({
			fileContent: [
				'![封面](feishu-bridge://image/image-token)',
				'![演示视频](feishu-bridge://video/video-token)',
			].join('\n'),
			noteName: 'Mixed',
			path: 'Inbox',
			vault: 'My Vault',
			behavior: 'create',
			url: 'https://tenant.feishu.cn/docx/example',
		});

		expect(confirmDownload).toHaveBeenCalledWith([
			'本次剪藏包含 1 个视频或大附件。下载可能较慢，并占用较多 Vault 空间。',
			'',
			'点击“确定”：下载到 Obsidian',
			'点击“取消”：视频/附件保留飞书链接，仅将图片保存到本地（推荐）',
		].join('\n'));
		expect(sendMessage).toHaveBeenCalledWith({
			action: 'saveFeishuWithBridge',
			input: expect.objectContaining({
				fileContent: [
					'![封面](feishu-bridge://image/image-token)',
					'[演示视频](https://tenant.feishu.cn/docx/example)',
				].join('\n'),
			}),
		});
	});

	test('falls back to normal note saving when all local assets are declined', async () => {
		useBridgeSettings('links', 'obsidian-bridge');
		vi.stubGlobal('confirm', vi.fn(() => false));
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

		await expect(saveFeishuToObsidian({
			fileContent: '[资料包](feishu-bridge://file/file-token)',
			noteName: 'File',
			path: 'Inbox',
			vault: 'My Vault',
			behavior: 'create',
			url: 'https://tenant.feishu.cn/docx/example',
		})).resolves.toEqual({
			handled: false,
			fileContent: '[资料包](https://tenant.feishu.cn/docx/example)',
		});
		expect(sendMessage).not.toHaveBeenCalled();
	});
});
