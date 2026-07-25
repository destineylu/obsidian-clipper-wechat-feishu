import { describe, expect, test } from 'vitest';

import {
	collectFeishuDirectMediaUrlsByToken,
	isAllowedFeishuDirectMediaUrl,
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
