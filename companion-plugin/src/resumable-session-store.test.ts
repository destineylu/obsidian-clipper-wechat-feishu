import {
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import type {
	BridgeTransaction,
	BridgeTransactionWriter,
} from './types';
import { RemoteMediaDownloadError } from './remote-media-downloader';
import {
	isTransientDownloadError,
	ResumableSessionStore,
} from './resumable-session-store';

function createWriter() {
	const committed: Array<{ transaction: BridgeTransaction; content: string }> = [];
	const writer: BridgeTransactionWriter = {
		reserveAssetPath: (_transactionId, index, filename) =>
			`Attachments/Web Clipper/${index}-${filename}`,
		commit: vi.fn(async (transaction, content) => {
			committed.push({ transaction, content });
			return {
				notePath: 'Clippings/Test.md',
				assetPaths: [...transaction.assets.values()].map(
					asset => asset.vaultPath
				),
			};
		}),
		release: vi.fn(),
	};
	return { writer, committed };
}

function createRequest() {
	return {
		resumeKey: 'a'.repeat(64),
		sourceKey: 'c'.repeat(64),
		note: {
			path: 'Clippings/Test',
			behavior: 'create' as const,
			content: [
				'{{FEISHU_BRIDGE_ASSET_0}}',
				'{{FEISHU_BRIDGE_ASSET_1}}',
			].join('\n'),
		},
		sourceOrigin: 'https://tenant.feishu.cn',
		assets: [
			{ index: 0, kind: 'image' as const, alt: '封面' },
			{ index: 1, kind: 'video' as const, alt: '演示' },
		],
	};
}

describe('resumable companion sessions', () => {
	test('treats Feishu frequency-limit code 99991400 as retryable', () => {
		expect(isTransientDownloadError(new RemoteMediaDownloadError(
			'remote_download_failed',
			'飞书开放平台媒体下载失败 (HTTP 400, 飞书错误码 99991400)',
			{
				httpStatus: 400,
				feishuCode: 99991400,
			}
		))).toBe(true);
		expect(isTransientDownloadError(new RemoteMediaDownloadError(
			'remote_download_failed',
			'飞书开放平台媒体下载失败 (HTTP 400, 飞书错误码 99991672)',
			{
				httpStatus: 400,
				feishuCode: 99991672,
			}
		))).toBe(false);
	});

	test('downloads queued assets, commits sanitized content, and persists no URLs', async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), 'bridge-session-test-'));
		const { writer, committed } = createWriter();
		let fallbackAttempts = 0;
		const downloadImpl = vi.fn(async options => {
			if (options.url.includes('/primary-image')) {
				throw new Error('primary parent type unavailable');
			}
			if (
				options.url.includes('/fallback-image') &&
				fallbackAttempts++ === 0
			) {
				throw new TypeError('Failed to fetch');
			}
			const bytes = new Uint8Array([options.destination.endsWith('0.part') ? 1 : 2]);
			const { writeFile } = await import('node:fs/promises');
			await writeFile(options.destination, bytes);
			options.onProgress?.(bytes.byteLength, 4);
			return {
				byteLength: 1,
				contentType: options.destination.endsWith('0.part')
					? 'image/png'
					: 'video/mp4',
				sha256: 'b'.repeat(64),
				...(options.destination.endsWith('0.part')
					? { suggestedFilename: 'server-mislabeled.jpeg' }
					: {}),
			};
		});
		const store = new ResumableSessionStore(writer, {
			rootDirectory,
			imageMaxBytes: 64,
			fileMaxBytes: 64,
			sessionMaxBytes: 128,
			retentionMs: 60_000,
			downloadConcurrency: 2,
		}, downloadImpl);
		await store.initialize();
		const created = await store.create(createRequest());

		await store.queueAssets(created.sessionId, {
			assets: [
				{
					index: 0,
					kind: 'image',
					filename: 'cover',
					downloadUrl: 'https://open.feishu.cn/open-apis/drive/v1/medias/primary-image/download',
					fallbackDownloadUrls: [
						'https://open.feishu.cn/open-apis/drive/v1/medias/fallback-image/download',
					],
					bearerToken: 'tenant-token',
				},
				{
					index: 1,
					kind: 'video',
					filename: 'demo',
					downloadUrl: 'https://s1-imfile.feishucdn.com/private-video',
				},
			],
		});
		await store.waitForIdle(created.sessionId);

		expect(store.getStatus(created.sessionId)).toMatchObject({
			phase: 'completed',
			completedAssets: 2,
			failedAssets: 0,
			downloadedBytes: 2,
			totalBytes: 8,
			notePath: 'Clippings/Test.md',
		});
		expect(committed[0].content).toContain(
			'![[Attachments/Web Clipper/0-server-mislabeled.png|封面]]'
		);
		expect(committed[0].content).toContain(
			'![[Attachments/Web Clipper/1-demo.mp4]]'
		);
		const manifest = await readFile(
			join(rootDirectory, created.sessionId, 'session.json'),
			'utf8'
		);
		expect(manifest).not.toContain('private-image');
		expect(manifest).not.toContain('private-video');
		expect(manifest).not.toContain('tenant-token');
		expect(manifest).not.toContain('primary-image');
		expect(manifest).not.toContain('fallback-image');
		expect(manifest).not.toContain('feishu-bridge://');
		expect(downloadImpl).toHaveBeenCalledWith(expect.objectContaining({
			url: expect.stringContaining('fallback-image'),
			bearerToken: 'tenant-token',
		}));
		expect(downloadImpl.mock.calls.filter(
			([options]) => options.url.includes('/fallback-image')
		)).toHaveLength(2);

		const resumed = await store.create(createRequest());
		expect(resumed.resumed).toBe(true);
		expect(resumed.sessionId).toBe(created.sessionId);
	});

	test('limits aggregate downloads across simultaneous sessions', async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), 'bridge-session-limit-'));
		const { writer } = createWriter();
		let activeDownloads = 0;
		let maximumActiveDownloads = 0;
		const downloadImpl = vi.fn(async options => {
			activeDownloads += 1;
			maximumActiveDownloads = Math.max(
				maximumActiveDownloads,
				activeDownloads
			);
			await new Promise(resolve => setTimeout(resolve, 10));
			const { writeFile } = await import('node:fs/promises');
			await writeFile(options.destination, new Uint8Array([1]));
			activeDownloads -= 1;
			return {
				byteLength: 1,
				contentType: 'image/png',
				sha256: 'c'.repeat(64),
			};
		});
		const store = new ResumableSessionStore(writer, {
			rootDirectory,
			imageMaxBytes: 64,
			fileMaxBytes: 64,
			sessionMaxBytes: 128,
			retentionMs: 60_000,
			downloadConcurrency: 1,
		}, downloadImpl);
		await store.initialize();
		const first = await store.create(createRequest());
		const second = await store.create({
			...createRequest(),
			resumeKey: 'b'.repeat(64),
			note: {
				...createRequest().note,
				path: 'Clippings/Test 2',
			},
		});
		const queue = {
			assets: [
				{
					index: 0,
					kind: 'image' as const,
					filename: 'one',
					downloadUrl: 'https://s1-imfile.feishucdn.com/one',
				},
				{
					index: 1,
					kind: 'video' as const,
					filename: 'two',
					downloadUrl: 'https://s1-imfile.feishucdn.com/two',
				},
			],
		};

		await Promise.all([
			store.queueAssets(first.sessionId, queue),
			store.queueAssets(second.sessionId, queue),
		]);
		await Promise.all([
			store.waitForIdle(first.sessionId),
			store.waitForIdle(second.sessionId),
		]);

		expect(maximumActiveDownloads).toBe(1);
		expect(store.getStatus(first.sessionId).phase).toBe('completed');
		expect(store.getStatus(second.sessionId).phase).toBe('completed');
	});

	test('resumes an existing redacted session after reload', async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), 'bridge-session-resume-'));
		const firstWriter = createWriter().writer;
		const first = new ResumableSessionStore(firstWriter, {
			rootDirectory,
			imageMaxBytes: 64,
			fileMaxBytes: 64,
			sessionMaxBytes: 128,
			retentionMs: 60_000,
			downloadConcurrency: 1,
		});
		await first.initialize();
		const created = await first.create(createRequest());
		await first.dispose();

		const second = new ResumableSessionStore(createWriter().writer, {
			rootDirectory,
			imageMaxBytes: 64,
			fileMaxBytes: 64,
			sessionMaxBytes: 128,
			retentionMs: 60_000,
			downloadConcurrency: 1,
		});
		await second.initialize();
		const resumed = await second.create(createRequest());

		expect(resumed.sessionId).toBe(created.sessionId);
		expect(resumed.resumed).toBe(true);
		expect(resumed.status.phase).toBe('waiting');
	});

	test('exposes legacy stringified-stream sessions as retryable and starts clean', async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), 'bridge-session-repair-'));
		const request = createRequest();
		const sessionId = 'legacy-stringified-stream';
		const sessionDirectory = join(rootDirectory, sessionId);
		const now = new Date();
		await mkdir(sessionDirectory);
		await writeFile(
			join(sessionDirectory, 'session.json'),
			JSON.stringify({
				version: 1,
				id: sessionId,
				resumeKey: request.resumeKey,
				sourceKey: request.sourceKey,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + 60_000).toISOString(),
				phase: 'completed',
				note: request.note,
				sourceOrigin: request.sourceOrigin,
				notePath: 'Clippings/Test.md',
				assets: [
					{
						index: 0,
						kind: 'image',
						alt: '封面',
						state: 'completed',
						byteLength: 23,
						expectedBytes: 1024,
						filename: 'cover.png',
						contentType: 'image/png',
						sha256:
							'7559c3628a54a498b715edbbb9a0f16fc65e94eaaf185b41e91f6bddf1a8e02e',
						tempFilename: '0.part',
						vaultPath: 'Attachments/Web Clipper/cover.png',
					},
					{
						index: 1,
						kind: 'video',
						alt: '演示',
						state: 'completed',
						byteLength: 2048,
						expectedBytes: 2048,
						filename: 'demo.mp4',
						contentType: 'video/mp4',
						sha256: 'c'.repeat(64),
						tempFilename: '1.part',
						vaultPath: 'Attachments/Web Clipper/demo.mp4',
					},
				],
			}),
			'utf8'
		);
		const store = new ResumableSessionStore(createWriter().writer, {
			rootDirectory,
			imageMaxBytes: 64,
			fileMaxBytes: 64,
			sessionMaxBytes: 128,
			retentionMs: 60_000,
			downloadConcurrency: 1,
		});
		await store.initialize();

		expect(store.getStatus(sessionId)).toMatchObject({
			phase: 'failed',
			completedAssets: 2,
			failedAssets: 1,
			error: expect.stringContaining('再次点击'),
		});
		const replacement = await store.create(request);
		expect(replacement.resumed).toBe(false);
		expect(replacement.sessionId).not.toBe(sessionId);
		expect(replacement.status.phase).toBe('waiting');
	});

	test('migrates a compatible legacy session to the stable resume identity', async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), 'bridge-session-migrate-'));
		const store = new ResumableSessionStore(createWriter().writer, {
			rootDirectory,
			imageMaxBytes: 64,
			fileMaxBytes: 64,
			sessionMaxBytes: 128,
			retentionMs: 60_000,
			downloadConcurrency: 1,
		});
		await store.initialize();
		const legacyRequest = { ...createRequest() };
		delete legacyRequest.sourceKey;
		const legacy = await store.create(legacyRequest);

		const resumed = await store.create({
			...createRequest(),
			resumeKey: 'd'.repeat(64),
		});

		expect(resumed.resumed).toBe(true);
		expect(resumed.sessionId).toBe(legacy.sessionId);
		const manifest = JSON.parse(await readFile(
			join(rootDirectory, legacy.sessionId, 'session.json'),
			'utf8'
		)) as { resumeKey: string; sourceKey?: string };
		expect(manifest.resumeKey).toBe('d'.repeat(64));
		expect(manifest.sourceKey).toBe('c'.repeat(64));
	});

});
