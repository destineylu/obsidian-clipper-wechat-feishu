import { describe, expect, test, vi } from 'vitest';

import {
	createDocumentCollectionBatches,
	createFeishuSessionContent,
	DEFAULT_FEISHU_BRIDGE_ENDPOINT,
	DOCUMENT_COLLECTION_BATCH_MAX_BYTES,
	DOCUMENT_COLLECTION_NOTE_MAX_BYTES,
	extractFeishuBridgeAssets,
	normalizeFeishuBridgeEndpoint,
	replaceFeishuBridgeAsset,
	type DocumentCollectionNoteRequest,
} from './bridge-protocol';

function collectionNote(pageId: string, byteLength: number): DocumentCollectionNoteRequest {
	return {
		pageId,
		path: `Docs/${pageId}.md`,
		content: String(byteLength),
		contentHash: '12345678',
	};
}

function withMockContentByteLengths<T>(run: () => T): T {
	vi.stubGlobal('TextEncoder', class {
		encode(value: string): Uint8Array {
			return { byteLength: Number(value) } as Uint8Array;
		}
	});
	try {
		return run();
	} finally {
		vi.unstubAllGlobals();
	}
}

describe('document collection batching', () => {
	test('keeps ordinary batches within 50 notes and 10 MiB', () => {
		withMockContentByteLengths(() => {
			const countLimited = createDocumentCollectionBatches(
				Array.from({ length: 51 }, (_, index) => collectionNote(String(index), 1))
			);
			expect(countLimited.map(batch => batch.length)).toEqual([50, 1]);

			const byteLimited = createDocumentCollectionBatches([
				collectionNote('a', 6 * 1024 * 1024),
				collectionNote('b', 6 * 1024 * 1024),
			]);
			expect(byteLimited.map(batch => batch.map(note => note.pageId))).toEqual([
				['a'],
				['b'],
			]);
		});
	});

	test('places a note over 10 MiB in an exclusive batch', () => {
		withMockContentByteLengths(() => {
			const batches = createDocumentCollectionBatches([
				collectionNote('before', 1),
				collectionNote('large', DOCUMENT_COLLECTION_BATCH_MAX_BYTES + 1),
				collectionNote('after', 1),
			]);
			expect(batches.map(batch => batch.map(note => note.pageId))).toEqual([
				['before'],
				['large'],
				['after'],
			]);
		});
	});

	test('allows a 64 MiB note and rejects anything larger', () => {
		withMockContentByteLengths(() => {
			expect(createDocumentCollectionBatches([
				collectionNote('maximum', DOCUMENT_COLLECTION_NOTE_MAX_BYTES),
			])).toHaveLength(1);
			expect(() => createDocumentCollectionBatches([
				collectionNote('too-large', DOCUMENT_COLLECTION_NOTE_MAX_BYTES + 1),
			])).toThrow(/64 MiB/);
		});
	});
});

describe('Feishu attachment bridge protocol', () => {
	test('normalizes an explicit loopback endpoint', () => {
		expect(normalizeFeishuBridgeEndpoint('http://localhost:27125/')).toBe(
			DEFAULT_FEISHU_BRIDGE_ENDPOINT
		);
		expect(normalizeFeishuBridgeEndpoint('http://127.0.0.1:28124')).toBe(
			'http://127.0.0.1:28124'
		);
	});

	test.each([
		'https://127.0.0.1:27125',
		'http://0.0.0.0:27125',
		'http://192.168.1.8:27125',
		'http://127.0.0.1:27125/path',
		'http://user:password@127.0.0.1:27125',
	])('rejects a non-private or malformed endpoint: %s', endpoint => {
		expect(() => normalizeFeishuBridgeEndpoint(endpoint)).toThrow();
	});

	test('extracts unique image markers while preserving occurrence metadata', () => {
		const markdown = [
			'![封面](feishu-bridge://image/token-a)',
			'![重复](feishu-bridge://image/token-a)',
			'![图二](feishu-bridge://image/token%20b)',
		].join('\n');

		expect(extractFeishuBridgeAssets(markdown)).toEqual([
			{
				token: 'token-a',
				alt: '封面',
				occurrences: 2,
				kind: 'image',
				downloadKind: 'image',
			},
			{
				token: 'token b',
				alt: '图二',
				occurrences: 1,
				kind: 'image',
				downloadKind: 'image',
			},
		]);
	});

	test('extracts image-file, video, and file markers as typed assets', () => {
		const markdown = [
			'![附件图片](feishu-bridge://image-file/image-token)',
			'![演示视频](feishu-bridge://video/video-token)',
			'[资料包](feishu-bridge://file/file-token)',
		].join('\n');

		expect(extractFeishuBridgeAssets(markdown)).toEqual([
			expect.objectContaining({
				token: 'image-token',
				kind: 'image',
				downloadKind: 'file',
			}),
			expect.objectContaining({
				token: 'video-token',
				kind: 'video',
				downloadKind: 'file',
			}),
			expect.objectContaining({
				token: 'file-token',
				kind: 'file',
				downloadKind: 'file',
			}),
		]);
	});

	test('extracts and deduplicates an encoded page-resource fallback', () => {
		const fallbackUrl = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/token-a?policy=test';
		const encodedFallback = encodeURIComponent(fallbackUrl);
		const markdown = [
			`![封面](feishu-bridge://image/token-a?fallback=${encodedFallback})`,
			'![重复](feishu-bridge://image/token-a)',
		].join('\n');

		expect(extractFeishuBridgeAssets(markdown)).toEqual([{
			token: 'token-a',
			alt: '封面',
			occurrences: 2,
			kind: 'image',
			downloadKind: 'image',
			fallbackUrl,
		}]);
	});

	test('replaces every matching marker with a portable Obsidian embed', () => {
		const markdown = [
			'![封面](feishu-bridge://image/token-a)',
			'![第二处](feishu-bridge://image/token-a)',
			'![保留](feishu-bridge://image/token-b)',
		].join('\n');

		expect(
			replaceFeishuBridgeAsset(markdown, 'token-a', '附件/文档/cover.png')
		).toBe([
			'![[附件/文档/cover.png|封面]]',
			'![[附件/文档/cover.png|第二处]]',
			'![保留](feishu-bridge://image/token-b)',
		].join('\n'));
	});

	test('escapes aliases and rejects unsafe vault paths', () => {
		expect(
			replaceFeishuBridgeAsset(
				'![a|b](feishu-bridge://image/token-a)',
				'token-a',
				'attachments/example.png'
			)
		).toBe('![[attachments/example.png|a\\|b]]');

		expect(() =>
			replaceFeishuBridgeAsset(
				'![x](feishu-bridge://image/token-a)',
				'token-a',
				'../outside.png'
			)
		).toThrow();
	});

	test('sanitizes private media markers into opaque session placeholders', () => {
		const markdown = [
			'![封面](feishu-bridge://image/private-image-token)',
			'![视频](feishu-bridge://video/private-video-token)',
		].join('\n');
		const assets = extractFeishuBridgeAssets(markdown);
		const content = createFeishuSessionContent(markdown, assets);

		expect(content).toBe([
			'{{FEISHU_BRIDGE_ASSET_0}}',
			'{{FEISHU_BRIDGE_ASSET_1}}',
		].join('\n'));
		expect(content).not.toContain('private-image-token');
		expect(content).not.toContain('private-video-token');
		expect(content).not.toContain('feishu-bridge://');
	});
});
