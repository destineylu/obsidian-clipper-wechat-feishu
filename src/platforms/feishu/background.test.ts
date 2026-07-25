import { afterEach, describe, expect, test, vi } from 'vitest';

import browser from '../../utils/browser-polyfill';
import {
	buildFeishuBridgeResumeKey,
	buildFeishuBridgeSourceKey,
	downloadFeishuBridgeAsset,
	hasFeishuBridgeUnauthorizedAssets,
	isAllowedFeishuBridgeDirectMediaUrl,
	readFeishuBridgeBinaryResponse,
	readFeishuMediaResponse,
	resolveFeishuRemoteAssetRequests,
} from './background';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('Feishu media streaming', () => {
	test('keeps resume identity stable when only signed fallback URLs change', async () => {
		const input = {
			fileContent: 'content',
			notePath: 'Clippings/Test',
			behavior: 'create' as const,
			sourceUrl: 'https://tenant.feishu.cn/docx/document',
			vault: 'Vault',
		};
		const firstAssets = [{
			token: 'image-token',
			alt: '',
			occurrences: 1,
			kind: 'image' as const,
			downloadKind: 'image' as const,
			fallbackUrl:
				'https://s1-imfile.feishucdn.com/image?signature=first',
		}];
		const secondAssets = [{
			...firstAssets[0],
			fallbackUrl:
				'https://s1-imfile.feishucdn.com/image?signature=second',
		}];

		await expect(buildFeishuBridgeResumeKey(input, firstAssets)).resolves.toBe(
			await buildFeishuBridgeResumeKey(input, secondAssets)
		);
		await expect(
			buildFeishuBridgeSourceKey(input.sourceUrl)
		).resolves.toMatch(/^[a-f0-9]{64}$/);
	});

	test('recognizes a resumable HTTP 401 as requiring a fresh tenant token', () => {
		expect(hasFeishuBridgeUnauthorizedAssets({
			sessionId: 'session',
			phase: 'failed',
			assetCount: 2,
			completedAssets: 1,
			failedAssets: 1,
			downloadedBytes: 1,
			assets: [
				{
					index: 0,
					kind: 'image',
					state: 'completed',
					byteLength: 1,
				},
				{
					index: 1,
					kind: 'image',
					state: 'failed',
					byteLength: 0,
					error: '飞书媒体下载失败 (HTTP 401)',
				},
			],
			updatedAt: new Date().toISOString(),
		})).toBe(true);
	});

	test('allows only exact Feishu direct-media hosts and paths', () => {
		expect(isAllowedFeishuBridgeDirectMediaUrl(
			'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/test'
		)).toBe(true);
		expect(isAllowedFeishuBridgeDirectMediaUrl(
			'https://s1-imfile.feishucdn.com/static/example'
		)).toBe(true);
		expect(isAllowedFeishuBridgeDirectMediaUrl(
			'https://evil.example/space/api/box/stream/download/preview/test'
		)).toBe(false);
		expect(isAllowedFeishuBridgeDirectMediaUrl(
			'https://internal-api-drive-stream.feishu.cn.evil.example/space/api/box/stream/download/preview/test'
		)).toBe(false);
	});

	test('rejects an oversized Content-Length before reading the body', async () => {
		const cancel = vi.fn(async () => undefined);
		const response = {
			headers: new Headers({
				'content-length': '1025',
				'content-type': 'image/png',
			}),
			body: { cancel },
		} as unknown as Response;

		await expect(readFeishuMediaResponse(response, 1024)).rejects.toThrow('too large');
		expect(cancel).toHaveBeenCalledOnce();
	});

	test('cancels a streaming response as soon as the cumulative limit is exceeded', async () => {
		const cancel = vi.fn(async () => undefined);
		const read = vi.fn()
			.mockResolvedValueOnce({ done: false, value: new Uint8Array(700) })
			.mockResolvedValueOnce({ done: false, value: new Uint8Array(400) });
		const response = {
			headers: new Headers({ 'content-type': 'image/png' }),
			body: {
				getReader: () => ({ read, cancel }),
			},
		} as unknown as Response;

		await expect(readFeishuMediaResponse(response, 1024)).rejects.toThrow('too large');
		expect(cancel).toHaveBeenCalled();
		expect(read).toHaveBeenCalledTimes(2);
	});

	test('returns a bounded data URL for a valid streamed response', async () => {
		const response = new Response(new Uint8Array([1, 2, 3, 4]), {
			headers: { 'content-type': 'image/png' },
		});

		const result = await readFeishuMediaResponse(response, 1024);

		expect(result.size).toBe(4);
		expect(result.contentType).toBe('image/png');
		expect(result.dataUrl).toBe('data:image/png;base64,AQIDBA==');
	});

	test('returns bounded binary data without Base64 for bridge uploads', async () => {
		const response = new Response(new Uint8Array([1, 2, 3, 4]), {
			headers: { 'content-type': 'image/png' },
		});

		const result = await readFeishuBridgeBinaryResponse(response, 1024);

		expect(result.size).toBe(4);
		expect(result.contentType).toBe('image/png');
		expect(result.body).toBeInstanceOf(Blob);
		expect([...new Uint8Array(await result.body.arrayBuffer())]).toEqual([
			1, 2, 3, 4,
		]);
	});

	test('uses the official temporary-download endpoint after direct API downloads fail', async () => {
		const temporaryUrl = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/token-a?policy=test';
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			feishu_settings: { appId: 'app-id', appSecret: 'app-secret' },
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/auth/v3/tenant_access_token/internal')) {
				return new Response(JSON.stringify({
					code: 0,
					tenant_access_token: 'tenant-token',
					expire: 7200,
				}), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url.includes('/media/batch_get_tmp_download_url')) {
				return new Response(JSON.stringify({
					code: 0,
					data: {
						tmp_download_urls: [{
							file_token: 'token-a',
							tmp_download_url: temporaryUrl,
						}],
					},
				}), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === temporaryUrl) {
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { 'content-type': 'image/png' },
				});
			}
			return new Response(null, { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await downloadFeishuBridgeAsset(
			{ token: 'token-a', alt: '封面', downloadKind: 'image' },
			'https://tenant.feishu.cn/docx/example',
			new AbortController().signal
		);

		expect(result.contentType).toBe('image/png');
		expect(result.byteLength).toBe(3);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/media/batch_get_tmp_download_url'),
			expect.objectContaining({
				headers: { Authorization: 'Bearer tenant-token' },
			})
		);
	});

	test('falls back to the exact page-observed media URL when app downloads stay unavailable', async () => {
		const fallbackUrl = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/token-b?policy=test';
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			feishu_settings: { appId: 'app-id', appSecret: 'app-secret' },
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/auth/v3/tenant_access_token/internal')) {
				return new Response(JSON.stringify({
					code: 0,
					tenant_access_token: 'tenant-token',
					expire: 7200,
				}), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === fallbackUrl) {
				return new Response(new Uint8Array([4, 5, 6, 7]), {
					status: 200,
					headers: { 'content-type': 'image/webp' },
				});
			}
			return new Response(null, { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await downloadFeishuBridgeAsset(
			{
				token: 'token-b',
				alt: '插图',
				fallbackUrl,
				downloadKind: 'image',
			},
			'https://tenant.feishu.cn/docx/example',
			new AbortController().signal
		);

		expect(result.contentType).toBe('image/webp');
		expect(result.byteLength).toBe(4);
		expect(fetchMock).toHaveBeenCalledWith(
			fallbackUrl,
			expect.objectContaining({ credentials: 'omit' })
		);
	});

	test('queues authenticated Open API candidates when no temporary URL is available', async () => {
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			feishu_settings: { appId: 'app-id', appSecret: 'app-secret' },
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/auth/v3/tenant_access_token/internal')) {
				return new Response(JSON.stringify({
					code: 0,
					tenant_access_token: 'tenant-token',
					expire: 7200,
				}), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url.includes('/media/batch_get_tmp_download_url')) {
				return new Response(JSON.stringify({
					code: 0,
					data: { tmp_download_urls: [] },
				}), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(null, { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const [request] = await resolveFeishuRemoteAssetRequests(
			[{
				token: 'token-auth-only',
				alt: '第 19 张图片',
				occurrences: 1,
				kind: 'image',
				downloadKind: 'image',
			}],
			[0],
			'https://tenant.feishu.cn/docx/example',
			new AbortController().signal
		);

		expect(request).toMatchObject({
			index: 0,
			kind: 'image',
			bearerToken: 'tenant-token',
		});
		expect(request.downloadUrl).toContain(
			'/open-apis/drive/v1/media/token-auth-only/download'
		);
		expect(request.fallbackDownloadUrls).toEqual(expect.arrayContaining([
			expect.stringContaining('parent_type=doc_image'),
			expect.stringContaining(
				'/open-apis/drive/v1/medias/token-auth-only/download'
			),
		]));
	});

	test('keeps authenticated API fallbacks when a signed page URL expires', async () => {
		const directUrl =
			'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/token-cookie?policy=test';
		vi.spyOn(browser.storage.local, 'get').mockResolvedValue({
			feishu_settings: { appId: 'app-id', appSecret: 'app-secret' },
		});
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/auth/v3/tenant_access_token/internal')) {
				return new Response(JSON.stringify({
					code: 0,
					tenant_access_token: 'tenant-token',
					expire: 7200,
				}), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(null, { status: 404 });
		}));

		const [request] = await resolveFeishuRemoteAssetRequests(
			[{
				token: 'token-cookie',
				alt: '受保护图片',
				occurrences: 1,
				kind: 'image',
				downloadKind: 'image',
				fallbackUrl: directUrl,
			}],
			[0],
			'https://tenant.feishu.cn/docx/example',
			new AbortController().signal
		);

		expect(request.downloadUrl).toBe(directUrl);
		expect(request.bearerToken).toBe('tenant-token');
		expect(request.fallbackDownloadUrls).toEqual(expect.arrayContaining([
			expect.stringContaining(
				'/open-apis/drive/v1/media/token-cookie/download'
			),
		]));
	});
});
