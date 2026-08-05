import { describe, expect, test, vi } from 'vitest';

import {
	FeishuBridgeClient,
	FeishuBridgeRequestError,
} from './bridge-client';

describe('FeishuBridgeClient', () => {
	test('authenticates health checks against the normalized loopback endpoint', async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(JSON.stringify({
				service: 'clipper-attachment-bridge',
				protocolVersion: 1,
				ready: true,
				vaultName: 'Test Vault',
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		);
		const client = new FeishuBridgeClient({
			endpoint: 'http://localhost:27124/',
			pairingToken: 'test-pairing-token',
			fetchImpl,
		});

		await expect(client.health()).resolves.toMatchObject({
			ready: true,
			vaultName: 'Test Vault',
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://127.0.0.1:27124/v1/health',
			expect.objectContaining({
				method: 'GET',
				headers: expect.objectContaining({
					Authorization: 'Bearer test-pairing-token',
				}),
			})
		);
	});

	test('uploads the original binary stream without Base64 conversion', async () => {
		const requests: Array<RequestInit & { duplex?: string }> = [];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0, 1, 2, 255]));
				controller.close();
			},
		});
		const fetchImpl = vi.fn(async (
			_input: RequestInfo | URL,
			init?: RequestInit & { duplex?: string }
		) => {
			if (init) requests.push(init);
			return new Response(JSON.stringify({
				index: 3,
				vaultPath: 'attachments/example.png',
				byteLength: 4,
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const client = new FeishuBridgeClient({
			endpoint: 'http://127.0.0.1:27124',
			pairingToken: 'test-token',
			fetchImpl,
		});

		await client.uploadAsset('transaction-1', 3, {
			body,
			filename: '图片.png',
			contentType: 'image/png',
			byteLength: 4,
		});

		const request = requests[0];
		expect(request.body).toBe(body);
		expect(request.duplex).toBe('half');
		expect(request.headers).toMatchObject({
			'Content-Type': 'image/png',
			'X-Asset-Filename': encodeURIComponent('图片.png'),
			'X-Asset-Size': '4',
		});
	});

	test('creates, queues, and reads a resumable session', async () => {
		const paths: string[] = [];
		const status = {
			sessionId: 'session-1',
			phase: 'waiting',
			assetCount: 1,
			completedAssets: 0,
			failedAssets: 0,
			downloadedBytes: 0,
			assets: [],
			updatedAt: new Date().toISOString(),
		};
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			paths.push(path);
			return new Response(JSON.stringify(
				path === '/v1/sessions'
					? { sessionId: 'session-1', resumed: false, status }
					: status
			), {
				status: path.endsWith('/queue') ? 202 : 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const client = new FeishuBridgeClient({
			endpoint: 'http://127.0.0.1:27124',
			pairingToken: 'test-token',
			fetchImpl,
		});

		await client.createSession({
			resumeKey: 'a'.repeat(64),
			note: {
				path: 'Clippings/Test',
				behavior: 'create',
				content: '{{FEISHU_BRIDGE_ASSET_0}}',
			},
			sourceOrigin: 'https://tenant.feishu.cn',
			assets: [{ index: 0, kind: 'image', alt: '封面' }],
		});
		await client.queueSessionAssets('session-1', {
			assets: [{
				index: 0,
				kind: 'image',
				filename: 'cover',
				downloadUrl: 'https://s1-imfile.feishucdn.com/private',
			}],
		});
		await client.getSessionStatus('session-1');

		expect(paths).toEqual([
			'/v1/sessions',
			'/v1/sessions/session-1/queue',
			'/v1/sessions/session-1',
		]);
	});

	test('surfaces structured server errors without exposing the pairing token', async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(JSON.stringify({
				error: {
					code: 'asset_too_large',
					message: '附件超过 20 MiB 限制',
				},
			}), {
				status: 413,
				headers: { 'Content-Type': 'application/json' },
			})
		);
		const client = new FeishuBridgeClient({
			endpoint: 'http://127.0.0.1:27124',
			pairingToken: 'must-not-leak',
			fetchImpl,
		});

		const error = await client.health().catch(value => value);
		expect(error).toBeInstanceOf(FeishuBridgeRequestError);
		expect(error).toMatchObject({
			code: 'asset_too_large',
			status: 413,
			message: '附件超过 20 MiB 限制',
		});
		expect(String(error)).not.toContain('must-not-leak');
	});

	test('writes a document bundle as one authenticated JSON request', async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
			notePaths: ['Docs/Index.md'],
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}));
		const client = new FeishuBridgeClient({
			endpoint: 'http://127.0.0.1:27124',
			pairingToken: 'test-token',
			fetchImpl,
		});

		await expect(client.writeDocumentBundle({
			behavior: 'overwrite',
			notes: [{ path: 'Docs/Index.md', content: '# Index' }],
		})).resolves.toEqual({ notePaths: ['Docs/Index.md'] });
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://127.0.0.1:27124/v1/document-bundles',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer test-token',
					'Content-Type': 'application/json',
				}),
			})
		);
	});

	test('creates, batches, and completes a resumable document collection', async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
			collectionId: 'llms-txt-12345678', resumed: false, totalPages: 1,
			completedPageIds: [], notePaths: {}, completed: false,
		}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
		const client = new FeishuBridgeClient({
			endpoint: 'http://127.0.0.1:27124', pairingToken: 'test-token', fetchImpl,
		});
		await client.createDocumentCollection({
			collectionId: 'llms-txt-12345678', title: 'Docs',
			rootUrl: 'https://example.com/docs/en/', locale: 'en', totalPages: 1,
		});
		await client.writeDocumentCollectionBatch('llms-txt-12345678', {
			notes: [{ pageId: 'intro', path: 'Docs/Intro.md', content: '# Intro', contentHash: '12345678' }],
		});
		await client.getDocumentCollectionStatus('llms-txt-12345678');
		await client.completeDocumentCollection('llms-txt-12345678', { expectedPageIds: ['intro'] });
		expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
			'http://127.0.0.1:27124/v1/document-collections',
			'http://127.0.0.1:27124/v1/document-collections/llms-txt-12345678/batches',
			'http://127.0.0.1:27124/v1/document-collections/llms-txt-12345678',
			'http://127.0.0.1:27124/v1/document-collections/llms-txt-12345678/complete',
		]);
	});

	test('rejects an empty pairing token before making a request', () => {
		expect(() => new FeishuBridgeClient({
			endpoint: 'http://127.0.0.1:27124',
			pairingToken: ' ',
		})).toThrow('配对令牌');
	});

	test('does not invoke the native fetch function as a client method', async () => {
		const originalFetch = globalThis.fetch;
		const nativeFetch = vi.fn(function (this: unknown) {
			expect(this).toBeUndefined();
			return Promise.resolve(new Response(JSON.stringify({
				service: 'clipper-attachment-bridge',
				protocolVersion: 1,
				ready: true,
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}));
		});
		globalThis.fetch = nativeFetch as typeof fetch;
		try {
			const client = new FeishuBridgeClient({
				endpoint: 'http://127.0.0.1:27124',
				pairingToken: 'test-token',
			});
			await expect(client.health()).resolves.toMatchObject({ ready: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
