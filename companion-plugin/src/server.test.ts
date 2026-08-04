// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { BridgeTransactionWriter, DocumentBundleWriter } from './types';
import {
	BridgeHttpServer,
	hashPairingToken,
} from './server';
import { TransactionStore } from './transaction-store';

const servers: BridgeHttpServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.stop()));
});

function createWriter(): BridgeTransactionWriter & DocumentBundleWriter {
	return {
		reserveAssetPath: vi.fn((_transactionId, index, filename) =>
			`Attachments/${index}-${filename}`
		),
		commit: vi.fn(async transaction => {
			const firstAsset = transaction.assets.get(0);
			if (firstAsset) {
				expect([...await readFile(firstAsset.tempPath)]).toEqual([0, 1, 2, 255]);
			}
			return {
				notePath: transaction.request.note.path,
				assetPaths: [...transaction.assets.values()].map(asset => asset.vaultPath),
			};
		}),
		commitDocumentBundle: vi.fn(async request => ({
			notePaths: request.notes.map(note => note.path),
		})),
		release: vi.fn(),
	};
}

describe('BridgeHttpServer', () => {
	test('allows a browser-extension private-network preflight', async () => {
		const writer = createWriter();
		const store = new TransactionStore(writer, {
			maxAssetBytes: 1024,
			maxTransactionBytes: 4096,
			transactionTtlMs: 60_000,
		});
		const server = new BridgeHttpServer({
			port: 0,
			pairingTokenHash: hashPairingToken('pairing-token'),
			vaultName: 'Test Vault',
			store,
		});
		servers.push(server);
		const port = await server.start();

		const response = await fetch(
			`http://127.0.0.1:${port}/v1/health`,
			{
				method: 'OPTIONS',
				headers: {
					Origin: 'chrome-extension://extension-id',
					'Access-Control-Request-Method': 'GET',
					'Access-Control-Request-Headers': 'authorization',
					'Access-Control-Request-Private-Network': 'true',
				},
			}
		);

		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		expect(
			response.headers.get('access-control-allow-private-network')
		).toBe('true');
	});

	test('requires a pairing token even for health checks', async () => {
		const writer = createWriter();
		const store = new TransactionStore(writer, {
			maxAssetBytes: 1024,
			maxTransactionBytes: 4096,
			transactionTtlMs: 60_000,
		});
		const server = new BridgeHttpServer({
			port: 0,
			pairingTokenHash: hashPairingToken('pairing-token'),
			vaultName: 'Test Vault',
			store,
		});
		servers.push(server);
		const port = await server.start();

		const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/health`);
		expect(unauthorized.status).toBe(401);

		const authorized = await fetch(`http://127.0.0.1:${port}/v1/health`, {
			headers: { Authorization: 'Bearer pairing-token' },
		});
		expect(authorized.status).toBe(200);
		await expect(authorized.json()).resolves.toMatchObject({
			service: 'clipper-attachment-bridge',
			protocolVersion: 1,
			ready: true,
			vaultName: 'Test Vault',
		});
	});

	test('advertises and routes resumable session capability', async () => {
		const writer = createWriter();
		const store = new TransactionStore(writer, {
			maxAssetBytes: 1024,
			maxTransactionBytes: 4096,
			transactionTtlMs: 60_000,
		});
		const status = {
			sessionId: 'session-1',
			phase: 'waiting' as const,
			assetCount: 1,
			completedAssets: 0,
			failedAssets: 0,
			downloadedBytes: 0,
			assets: [{
				index: 0,
				kind: 'image' as const,
				state: 'pending' as const,
				byteLength: 0,
			}],
			updatedAt: new Date().toISOString(),
		};
		const resumableStore = {
			create: vi.fn(async () => ({
				sessionId: 'session-1',
				resumed: false,
				status,
			})),
			getStatus: vi.fn(() => status),
			queueAssets: vi.fn(async () => status),
			retryCommit: vi.fn(async () => status),
			abort: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		const server = new BridgeHttpServer({
			port: 0,
			pairingTokenHash: hashPairingToken('pairing-token'),
			vaultName: 'Test Vault',
			store,
			resumable: {
				store: resumableStore,
				limits: {
					imageBytes: 64,
					fileBytes: 1024,
					sessionBytes: 4096,
				},
			},
		});
		servers.push(server);
		const port = await server.start();
		const endpoint = `http://127.0.0.1:${port}`;
		const headers = {
			Authorization: 'Bearer pairing-token',
			'Content-Type': 'application/json',
		};

		const health = await fetch(`${endpoint}/v1/health`, { headers });
		await expect(health.json()).resolves.toMatchObject({
			capabilities: [
				'resumable-remote-media-v1',
			],
			limits: {
				imageBytes: 64,
				fileBytes: 1024,
				sessionBytes: 4096,
			},
		});

		const created = await fetch(`${endpoint}/v1/sessions`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				resumeKey: 'a'.repeat(64),
				note: {
					path: 'Clippings/Test',
					behavior: 'create',
					content: '{{FEISHU_BRIDGE_ASSET_0}}',
				},
				sourceOrigin: 'https://tenant.feishu.cn',
				assets: [{ index: 0, kind: 'image', alt: '封面' }],
			}),
		});
		expect(created.status).toBe(201);
		await expect(created.json()).resolves.toMatchObject({
			sessionId: 'session-1',
			resumed: false,
		});

		const fetched = await fetch(
			`${endpoint}/v1/sessions/session-1`,
			{ headers }
		);
		expect(fetched.status).toBe(200);
		await expect(fetched.json()).resolves.toMatchObject({
			sessionId: 'session-1',
			phase: 'waiting',
		});

	});

	test('accepts a raw binary upload and commits the transaction', async () => {
		const writer = createWriter();
		const store = new TransactionStore(writer, {
			maxAssetBytes: 1024,
			maxTransactionBytes: 4096,
			transactionTtlMs: 60_000,
		});
		const server = new BridgeHttpServer({
			port: 0,
			pairingTokenHash: hashPairingToken('pairing-token'),
			vaultName: 'Test Vault',
			store,
		});
		servers.push(server);
		const port = await server.start();
		const endpoint = `http://127.0.0.1:${port}`;
		const headers = {
			Authorization: 'Bearer pairing-token',
		};

		const createResponse = await fetch(`${endpoint}/v1/transactions`, {
			method: 'POST',
			headers: {
				...headers,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				note: {
					path: 'Inbox/Test.md',
					behavior: 'create',
					content: '# Draft',
				},
				sourceUrl: 'https://example.com/document',
				assetCount: 1,
			}),
		});
		expect(createResponse.status).toBe(201);
		const { transactionId } = await createResponse.json() as {
			transactionId: string;
		};

		const uploadResponse = await fetch(
			`${endpoint}/v1/transactions/${transactionId}/assets/0`,
			{
				method: 'PUT',
				headers: {
					...headers,
					'Content-Type': 'image/png',
					'X-Asset-Filename': encodeURIComponent('image.png'),
					'X-Asset-Size': '4',
				},
				body: new Uint8Array([0, 1, 2, 255]),
			}
		);
		expect(uploadResponse.status).toBe(200);
		await expect(uploadResponse.json()).resolves.toMatchObject({
			index: 0,
			byteLength: 4,
			vaultPath: 'Attachments/0-image.png',
		});

		const commitResponse = await fetch(
			`${endpoint}/v1/transactions/${transactionId}/commit`,
			{
				method: 'POST',
				headers: {
					...headers,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ content: '# Final' }),
			}
		);
		expect(commitResponse.status).toBe(200);
		await expect(commitResponse.json()).resolves.toEqual({
			notePath: 'Inbox/Test.md',
			assetPaths: ['Attachments/0-image.png'],
		});
		expect(writer.commit).toHaveBeenCalledTimes(1);
	});

	test('advertises and validates document bundle writes', async () => {
		const writer = createWriter();
		const store = new TransactionStore(writer, {
			maxAssetBytes: 1024,
			maxTransactionBytes: 4096,
			transactionTtlMs: 60_000,
		});
		const server = new BridgeHttpServer({
			port: 0,
			pairingTokenHash: hashPairingToken('pairing-token'),
			vaultName: 'Test Vault',
			store,
			documentBundleWriter: writer,
		});
		servers.push(server);
		const port = await server.start();
		const endpoint = `http://127.0.0.1:${port}`;
		const headers = {
			Authorization: 'Bearer pairing-token',
			'Content-Type': 'application/json',
		};

		const health = await fetch(`${endpoint}/v1/health`, { headers });
		await expect(health.json()).resolves.toMatchObject({
			capabilities: ['document-bundle-v1'],
		});

		const valid = await fetch(`${endpoint}/v1/document-bundles`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				behavior: 'overwrite',
				notes: [
					{ path: 'Docs/Index.md', content: '# Index' },
					{ path: 'Docs/Guide.md', content: '# Guide' },
				],
			}),
		});
		expect(valid.status).toBe(200);
		await expect(valid.json()).resolves.toEqual({
			notePaths: ['Docs/Index.md', 'Docs/Guide.md'],
		});
		expect(writer.commitDocumentBundle).toHaveBeenCalledTimes(1);

		for (const invalidBody of [
			{
				behavior: 'overwrite',
				notes: [{ path: '../outside.md', content: 'x' }],
			},
			{
				behavior: 'overwrite',
				notes: [
					{ path: 'Docs/Same.md', content: 'x' },
					{ path: 'docs/same.md', content: 'y' },
				],
			},
			{
				behavior: 'overwrite',
				notes: Array.from({ length: 102 }, (_, index) => ({
					path: `Docs/${index}.md`,
					content: 'x',
				})),
			},
		]) {
			const response = await fetch(`${endpoint}/v1/document-bundles`, {
				method: 'POST',
				headers,
				body: JSON.stringify(invalidBody),
			});
			expect(response.status).toBe(400);
		}
	});
});
