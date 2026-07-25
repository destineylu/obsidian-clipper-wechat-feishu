import { EventEmitter } from 'node:events';
import {
	mkdtemp,
	readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
	downloadRemoteMedia,
	fetchWithNativeHttps,
	isAllowedFeishuRemoteUrl,
	RemoteMediaDownloadError,
} from './remote-media-downloader';

afterEach(() => vi.unstubAllGlobals());

describe('remote Feishu media downloader', () => {
	test('allows only the known HTTPS media endpoints', () => {
		expect(isAllowedFeishuRemoteUrl(
			'https://s1-imfile.feishucdn.com/example'
		)).toBe(true);
		expect(isAllowedFeishuRemoteUrl(
			'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/example'
		)).toBe(true);
		expect(isAllowedFeishuRemoteUrl(
			'https://open.feishu.cn/open-apis/drive/v1/medias/token/download?parent_type=docx_image'
		)).toBe(true);
		expect(isAllowedFeishuRemoteUrl(
			'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
		)).toBe(false);
		expect(isAllowedFeishuRemoteUrl('https://example.com/file')).toBe(false);
		expect(isAllowedFeishuRemoteUrl('http://s1-imfile.feishucdn.com/file')).toBe(false);
	});

	test('streams bytes to disk and returns a checksum', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'bridge-remote-test-'));
		const destination = join(directory, 'asset.part');
		const pngHeader = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47,
			0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const fetchImpl = vi.fn(async () => new Response(
			pngHeader,
			{
				headers: {
					'content-type': 'image/png',
					'content-length': String(pngHeader.byteLength),
					'content-disposition': 'attachment; filename="image.png"',
				},
			}
		));

		const result = await downloadRemoteMedia({
			url: 'https://s1-imfile.feishucdn.com/example',
			destination,
			maxBytes: 16,
			fetchImpl,
		});

		expect(new Uint8Array(await readFile(destination))).toEqual(
			pngHeader
		);
		expect(result).toMatchObject({
			byteLength: pngHeader.byteLength,
			contentType: 'image/png',
			suggestedFilename: 'image.png',
		});
		expect(result.sha256).toHaveLength(64);
	});

	test('uses the real PNG signature when Feishu mislabels it as JPEG', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'bridge-mime-test-'));
		const destination = join(directory, 'asset.part');
		const pngHeader = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47,
			0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const fetchImpl = vi.fn(async () => new Response(pngHeader, {
			headers: {
				'content-type': 'image/jpeg',
				'content-length': String(pngHeader.byteLength),
			},
		}));

		const result = await downloadRemoteMedia({
			url: 'https://open.feishu.cn/open-apis/drive/v1/medias/token/download?parent_type=docx_image',
			destination,
			maxBytes: 16,
			bearerToken: 'tenant-token',
			fetchImpl,
		});

		expect(result.contentType).toBe('image/png');
		expect(new Uint8Array(await readFile(destination))).toEqual(pngHeader);
	});

	test('creates a streaming response through native HTTPS without browser fetch', async () => {
		const browserFetch = vi.fn(() => {
			throw new Error('browser fetch must not be used');
		});
		vi.stubGlobal('fetch', browserFetch);
		const responseStream = new PassThrough();
		Object.assign(responseStream, {
			statusCode: 200,
			statusMessage: 'OK',
			headers: {
				'content-type': 'image/png',
				'content-length': '3',
			},
		});
		const request = new EventEmitter() as EventEmitter & {
			setTimeout: ReturnType<typeof vi.fn>;
			destroy: ReturnType<typeof vi.fn>;
			end: ReturnType<typeof vi.fn>;
		};
		request.setTimeout = vi.fn();
		request.destroy = vi.fn(error => request.emit('error', error));
		let respond: ((response: typeof responseStream) => void) | undefined;
		request.end = vi.fn(() => {
			queueMicrotask(() => {
				respond?.(responseStream);
				responseStream.end(new Uint8Array([7, 8, 9]));
			});
		});
		const requestImpl = vi.fn((_url, _options, callback) => {
			respond = callback;
			return request;
		});

		const responseConstructor = vi.fn(() => {
			throw new Error('Response constructor must not wrap a Node stream');
		});
		vi.stubGlobal('Response', responseConstructor);
		const response = await fetchWithNativeHttps(
			'https://open.feishu.cn/open-apis/drive/v1/medias/token/download',
			{
				headers: { Authorization: 'Bearer tenant-token' },
			},
			requestImpl as never
		);
		const reader = response.body?.getReader();
		const first = await reader?.read();
		const second = await reader?.read();

		expect(first).toMatchObject({
			done: false,
			value: new Uint8Array([7, 8, 9]),
		});
		expect(second).toMatchObject({ done: true });
		expect(responseConstructor).not.toHaveBeenCalled();
		expect(browserFetch).not.toHaveBeenCalled();
		expect(requestImpl.mock.calls[0][1]).toMatchObject({
			headers: {
				'accept-encoding': 'identity',
				authorization: 'Bearer tenant-token',
			},
		});
	});

	test('uses a bearer token only on the official API request, not its CDN redirect', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'bridge-auth-test-'));
		const destination = join(directory, 'asset.part');
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(new Response(null, {
				status: 302,
				headers: {
					location: 'https://s2-imfile.feishucdn.com/private-image',
				},
			}))
			.mockResolvedValueOnce(new Response(
				new Uint8Array([5, 6, 7]),
				{ headers: { 'content-type': 'application/octet-stream' } }
			));

		const result = await downloadRemoteMedia({
			url: 'https://open.feishu.cn/open-apis/drive/v1/medias/token/download?parent_type=docx_image',
			destination,
			maxBytes: 16,
			bearerToken: 'tenant-token',
			fetchImpl,
		});

		expect(result.byteLength).toBe(3);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls[0][1]).toMatchObject({
			headers: { Authorization: 'Bearer tenant-token' },
			redirect: 'manual',
		});
		expect(fetchImpl.mock.calls[1][1]).not.toHaveProperty('headers');
	});

	test('rejects an allowed redirect that points outside the allowlist', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, {
			status: 302,
			headers: { location: 'http://127.0.0.1/private' },
		}));

		await expect(downloadRemoteMedia({
			url: 'https://s1-imfile.feishucdn.com/example',
			destination: join(tmpdir(), 'blocked-redirect.part'),
			maxBytes: 16,
			fetchImpl,
		})).rejects.toThrow('允许范围');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test('rejects a response larger than the configured limit before writing', async () => {
		const fetchImpl = vi.fn(async () => new Response(
			new Uint8Array([1, 2, 3, 4]),
			{ headers: { 'content-length': '4' } }
		));

		await expect(downloadRemoteMedia({
			url: 'https://s1-imfile.feishucdn.com/example',
			destination: join(tmpdir(), 'oversized.part'),
			maxBytes: 3,
			fetchImpl,
		})).rejects.toThrow('大小限制');
	});

	test('keeps the Feishu API error code but redacts identifiers in diagnostics', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
			code: 99991672,
			msg: 'Access denied for document doxcn123456789012345678901234',
		}), {
			status: 401,
			headers: { 'content-type': 'application/json' },
		}));

		await expect(downloadRemoteMedia({
			url: 'https://open.feishu.cn/open-apis/drive/v1/media/media-token/download',
			destination: join(tmpdir(), 'api-error.part'),
			maxBytes: 16,
			bearerToken: 'tenant-token',
			fetchImpl,
		})).rejects.toThrow(
			'HTTP 401, 飞书错误码 99991672: Access denied for document <redacted-id>'
		);
	});

	test('preserves Feishu frequency-limit metadata for automatic retry', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
			code: 99991400,
			msg: 'request trigger frequency limit',
		}), {
			status: 400,
			headers: {
				'content-type': 'application/json',
				'retry-after': '2',
			},
		}));

		try {
			await downloadRemoteMedia({
				url: 'https://open.feishu.cn/open-apis/drive/v1/media/media-token/download',
				destination: join(tmpdir(), 'rate-limit.part'),
				maxBytes: 16,
				bearerToken: 'tenant-token',
				fetchImpl,
			});
			throw new Error('Expected the rate-limited request to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(RemoteMediaDownloadError);
			expect(error).toMatchObject({
				code: 'remote_download_failed',
				httpStatus: 400,
				feishuCode: 99991400,
				retryAfterMs: 2_000,
			});
		}
	});

	test('rejects a zero-byte response instead of marking a broken asset complete', async () => {
		const destination = join(tmpdir(), 'empty-asset.part');
		const fetchImpl = vi.fn(async () => new Response(
			new Uint8Array(),
			{ headers: { 'content-length': '0' } }
		));

		await expect(downloadRemoteMedia({
			url: 'https://s1-imfile.feishucdn.com/empty',
			destination,
			maxBytes: 16,
			fetchImpl,
		})).rejects.toThrow('空文件');
		await expect(readFile(destination)).rejects.toThrow();
	});

	test('rejects and removes a truncated response', async () => {
		const destination = join(tmpdir(), 'truncated-asset.part');
		const fetchImpl = vi.fn(async () => new Response(
			new Uint8Array([0x89, 0x50, 0x4e]),
			{
				headers: {
					'content-type': 'image/png',
					'content-length': '8',
				},
			}
		));

		await expect(downloadRemoteMedia({
			url: 'https://s1-imfile.feishucdn.com/truncated',
			destination,
			maxBytes: 16,
			fetchImpl,
		})).rejects.toThrow('下载不完整');
		await expect(readFile(destination)).rejects.toThrow();
	});

	test('rejects a stringified ReadableStream response as invalid media', async () => {
		const destination = join(tmpdir(), 'stringified-stream.part');
		const payload = new TextEncoder().encode('[object ReadableStream]');
		const fetchImpl = vi.fn(async () => new Response(payload, {
			headers: { 'content-type': 'image/png' },
		}));

		await expect(downloadRemoteMedia({
			url: 'https://s1-imfile.feishucdn.com/stringified',
			destination,
			maxBytes: 64,
			fetchImpl,
		})).rejects.toThrow('不是有效的图片或视频');
		await expect(readFile(destination)).rejects.toThrow();
	});
});
