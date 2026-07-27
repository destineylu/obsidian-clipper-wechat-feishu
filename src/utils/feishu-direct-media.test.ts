import { describe, expect, test } from 'vitest';

import {
	collectFeishuDirectMediaUrlsByToken,
	isAllowedFeishuDirectMediaUrl,
	isFeishuDocUrl,
	parseFeishuUrl,
} from './feishu-extractor';

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
