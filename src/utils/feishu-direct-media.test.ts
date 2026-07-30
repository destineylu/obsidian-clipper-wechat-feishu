import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('./debug', () => ({
	debugLog: vi.fn(),
}));

import { debugLog } from './debug';
import {
	collectFeishuDirectMediaUrlsByToken,
	isAllowedFeishuDirectMediaUrl,
	isFeishuDocUrl,
	parseFeishuUrl,
} from './feishu-extractor';

afterEach(() => {
	vi.clearAllMocks();
});

describe('Feishu page media fallback mapping', () => {
	test('maps an observed direct-media resource to its image token', () => {
		const resourceUrl = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/token-a?policy=test';

		expect(collectFeishuDirectMediaUrlsByToken([resourceUrl])).toEqual(
			new Map([['token-a', resourceUrl]])
		);
	});

	test('rejects lookalike hosts and unrelated paths', () => {
		expect(isAllowedFeishuDirectMediaUrl(
			'https://internal-api-drive-stream.feishu.cn.evil.example/space/api/box/stream/download/v2/token-a'
		)).toBe(false);
		expect(isAllowedFeishuDirectMediaUrl(
			'https://internal-api-drive-stream.feishu.cn/unrelated/token-a'
		)).toBe(false);
	});

	test('logs only the hostname for rejected Feishu or Lark media candidates', () => {
		const rejectedUrl =
			'https://sf16-sg.larksuitecdn.com/obj/private-media-token?signature=secret';

		expect(collectFeishuDirectMediaUrlsByToken([rejectedUrl])).toEqual(
			new Map()
		);
		expect(debugLog).toHaveBeenCalledWith(
			'Feishu',
			'Rejected direct media hosts outside allowlist',
			{
				hostnames: ['sf16-sg.larksuitecdn.com'],
				rejectedResourceCount: 1,
			}
		);
		expect(JSON.stringify(vi.mocked(debugLog).mock.calls))
			.not.toContain('private-media-token');
		expect(JSON.stringify(vi.mocked(debugLog).mock.calls))
			.not.toContain('signature=secret');
	});
});

describe('Feishu complex resource URL detection', () => {
	test('recognizes direct Sheets and Bitable URLs', () => {
		expect(isFeishuDocUrl('https://example.feishu.cn/sheets/sht-example?sheet=abc123')).toBe(true);
		expect(isFeishuDocUrl('https://example.feishu.cn/base/bascn-example?table=tbl123')).toBe(true);
		expect(parseFeishuUrl('https://example.feishu.cn/sheets/sht-example')).toEqual({
			type: 'sheet',
			token: 'sht-example',
		});
		expect(parseFeishuUrl('https://example.feishu.cn/base/bascn-example')).toEqual({
			type: 'bitable',
			token: 'bascn-example',
		});
	});

	test('does not accept lookalike Feishu hosts', () => {
		expect(isFeishuDocUrl('https://example.feishu.cn.evil.test/sheets/token')).toBe(false);
	});
});
