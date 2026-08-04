import { describe, expect, test } from 'vitest';
import {
	buildFeishuImageBrowserFallbackUrl,
	isAllowedFeishuDirectMediaUrl,
} from './feishu-extractor';

describe('Feishu image browser fallback URLs', () => {
	test('builds an allowlisted URL from the structured image token and block id', () => {
		const url = buildFeishuImageBrowserFallbackUrl(
			'image-token',
			'image-block-id'
		);

		expect(url).toBe(
			'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/image-token/?fallback_source=1&mount_node_token=image-block-id&mount_point=docx_image&policy=equal&width=1280'
		);
		expect(isAllowedFeishuDirectMediaUrl(url || '')).toBe(true);
	});

	test('rejects identifiers that could change the official URL structure', () => {
		expect(buildFeishuImageBrowserFallbackUrl(
			'../../outside',
			'image-block-id'
		)).toBeUndefined();
		expect(buildFeishuImageBrowserFallbackUrl(
			'image-token',
			'block?id=other'
		)).toBeUndefined();
	});
});
