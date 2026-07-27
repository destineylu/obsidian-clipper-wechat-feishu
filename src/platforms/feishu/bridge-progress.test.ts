import { afterEach, describe, expect, test, vi } from 'vitest';

import browser from '../../utils/browser-polyfill';
import {
	clearFeishuBridgeProgress,
	hashFeishuBridgeSource,
	isFeishuBridgeProgressForSource,
	isFeishuBridgeSessionActive,
	loadFeishuBridgeProgress,
	saveFeishuBridgeProgress,
} from './bridge-progress';

afterEach(() => vi.restoreAllMocks());

describe('Feishu bridge progress persistence', () => {
	test('keeps progress updates scoped to the current Feishu document', () => {
		expect(isFeishuBridgeProgressForSource(
			'https://tenant.feishu.cn/docx/doc-a#section',
			'https://tenant.feishu.cn/docx/doc-a'
		)).toBe(true);
		expect(isFeishuBridgeProgressForSource(
			'https://tenant.feishu.cn/docx/doc-b',
			'https://tenant.feishu.cn/docx/doc-a'
		)).toBe(false);
		expect(isFeishuBridgeProgressForSource('', '')).toBe(false);
	});

	test('treats an idle resumable session as retryable, not busy', () => {
		expect(isFeishuBridgeSessionActive('waiting')).toBe(false);
		expect(isFeishuBridgeSessionActive('failed')).toBe(false);
		expect(isFeishuBridgeSessionActive('completed')).toBe(false);
		expect(isFeishuBridgeSessionActive('downloading')).toBe(true);
		expect(isFeishuBridgeSessionActive('ready')).toBe(true);
		expect(isFeishuBridgeSessionActive('committing')).toBe(true);
	});

	test('clears stale progress without storing the source URL', async () => {
		const sourceUrl = 'https://tenant.feishu.cn/docx/doc-a';
		const remove = vi.spyOn(browser.storage.local, 'remove')
			.mockResolvedValue(undefined);

		await clearFeishuBridgeProgress(sourceUrl);

		expect(remove).toHaveBeenCalledWith(
			`feishu_bridge_progress_${await hashFeishuBridgeSource(sourceUrl)}`
		);
		expect(JSON.stringify(remove.mock.calls)).not.toContain(
			'private-document-token'
		);
	});

	test('stores progress under a source hash without persisting the document URL', async () => {
		const sourceUrl = 'https://tenant.feishu.cn/docx/doc-a';
		let stored: Record<string, unknown> = {};
		vi.spyOn(browser.storage.local, 'set').mockImplementation(async value => {
			stored = { ...stored, ...value };
		});
		vi.spyOn(browser.storage.local, 'get').mockImplementation(async key => {
			const name = String(key);
			return { [name]: stored[name] };
		});

		await saveFeishuBridgeProgress(sourceUrl, {
			sessionId: 'session-1',
			phase: 'downloading',
			assetCount: 280,
			completedAssets: 42,
			failedAssets: 0,
			downloadedBytes: 1234,
			totalBytes: 5678,
			isTotalBytesFinal: false,
			activeAssets: 3,
			retryingAssets: 1,
			retryAfterMs: 900,
			bytesPerSecond: 1024,
			assets: [],
			updatedAt: new Date().toISOString(),
		});

		expect(JSON.stringify(stored)).not.toContain('private-document-token');
		expect(Object.keys(stored)[0]).toBe(
			`feishu_bridge_progress_${await hashFeishuBridgeSource(sourceUrl)}`
		);
		await expect(loadFeishuBridgeProgress(sourceUrl)).resolves.toMatchObject({
			sessionId: 'session-1',
			completedAssets: 42,
			assetCount: 280,
			isTotalBytesFinal: false,
			activeAssets: 3,
			retryingAssets: 1,
			bytesPerSecond: 1024,
		});
	});

	test('turns an HTTP 401 asset failure into actionable permission guidance', async () => {
		let stored: Record<string, unknown> = {};
		vi.spyOn(browser.storage.local, 'set').mockImplementation(async value => {
			stored = { ...stored, ...value };
		});

		const progress = await saveFeishuBridgeProgress(
			'https://tenant.feishu.cn/docx/example',
			{
				sessionId: 'session-2',
				phase: 'failed',
				assetCount: 1,
				completedAssets: 0,
				failedAssets: 1,
				downloadedBytes: 0,
				assets: [{
					index: 0,
					kind: 'image',
					state: 'failed',
					byteLength: 0,
					error: '飞书媒体下载失败 (HTTP 401)',
				}],
				updatedAt: new Date().toISOString(),
			}
		);

		expect(progress.error).toContain('未使用 Cookie');
		expect(JSON.stringify(stored)).toContain(
			'应用的数据访问范围'
		);
	});
});
