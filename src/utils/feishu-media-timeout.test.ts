import { afterEach, describe, expect, test, vi } from 'vitest';
import browser from './browser-polyfill';

import { fetchFeishuMediaAsDataUrl } from './feishu-extractor';

describe('Feishu media request cancellation', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test('sends an explicit cancellation when the caller deadline expires', async () => {
		vi.useFakeTimers();
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (request: any) => {
			if (request.action === 'cancelFeishuMedia') return { success: true };
			return new Promise(() => {});
		});

		const request = fetchFeishuMediaAsDataUrl(
			'https://open.feishu.cn/open-apis/drive/v1/medias/test/download',
			1024,
			50
		);
		const rejection = expect(request).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(1_050);
		await rejection;

		expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			action: 'cancelFeishuMedia',
			requestId: expect.any(String),
		}));
	});
});
