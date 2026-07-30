import { describe, expect, test, vi } from 'vitest';

import {
	transferFeishuNoteWithBridge,
	transferFeishuNoteWithResumableBridge,
	type FeishuBridgeTransferDependencies,
} from './background';

function createDependencies(): FeishuBridgeTransferDependencies {
	return {
		client: {
			health: vi.fn(async () => ({
				service: 'clipper-attachment-bridge' as const,
				protocolVersion: 1,
				ready: true,
				vaultName: 'My Vault',
			})),
			createTransaction: vi.fn(async () => ({
				transactionId: 'transaction-1',
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})),
			uploadAsset: vi.fn(async (_transactionId, index, options) => ({
				index,
				vaultPath: `Attachments/image-${index}.png`,
				byteLength: options.byteLength || 4,
			})),
			commitTransaction: vi.fn(async (_transactionId, content) => ({
				notePath: 'Inbox/Test.md',
				assetPaths: content.includes('image-1.png')
					? ['Attachments/image-0.png', 'Attachments/image-1.png']
					: [],
			})),
			abortTransaction: vi.fn(async () => undefined),
			createSession: vi.fn(async () => {
				throw new Error('not used');
			}),
			getSessionStatus: vi.fn(async () => {
				throw new Error('not used');
			}),
			queueSessionAssets: vi.fn(async () => {
				throw new Error('not used');
			}),
			retrySessionCommit: vi.fn(async () => {
				throw new Error('not used');
			}),
			abortSession: vi.fn(async () => undefined),
		},
		downloadAsset: vi.fn(async (asset) => ({
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([0, 1, 2, 3]));
					controller.close();
				},
			}),
			filename: `${asset.alt || 'image'}.png`,
			contentType: 'image/png',
			byteLength: 4,
		})),
	};
}

describe('Feishu attachment bridge transfer', () => {
	test('deduplicates markers and sends only raw binary bodies to the companion', async () => {
		const dependencies = createDependencies();
		const result = await transferFeishuNoteWithBridge({
			fileContent: [
				'![封面](feishu-bridge://image/token-a)',
				'![重复](feishu-bridge://image/token-a)',
				'![第二张](feishu-bridge://image/token-b)',
			].join('\n'),
			notePath: 'Inbox/Test.md',
			behavior: 'create',
			sourceUrl: 'https://tenant.feishu.cn/docx/doc-a',
			vault: 'My Vault',
		}, dependencies);

		expect(result).toEqual({
			notePath: 'Inbox/Test.md',
			assetPaths: ['Attachments/image-0.png', 'Attachments/image-1.png'],
		});
		expect(dependencies.downloadAsset).toHaveBeenCalledTimes(2);
		expect(dependencies.client.uploadAsset).toHaveBeenCalledTimes(2);

		const createRequest = vi.mocked(
			dependencies.client.createTransaction
		).mock.calls[0][0];
		expect(createRequest.note.content).toBe('');
		expect(createRequest.sourceUrl).toBe('https://tenant.feishu.cn');
		expect(JSON.stringify(createRequest)).not.toContain('token-a');
		expect(JSON.stringify(createRequest)).not.toContain('private-document-token');

		const committedContent = vi.mocked(
			dependencies.client.commitTransaction
		).mock.calls[0][1];
		expect(committedContent).toContain('![[Attachments/image-0.png|封面]]');
		expect(committedContent).toContain('![[Attachments/image-0.png|重复]]');
		expect(committedContent).toContain('![[Attachments/image-1.png|第二张]]');
		expect(committedContent).not.toContain('feishu-bridge://');
	});

	test('aborts the companion transaction when an asset fails', async () => {
		const dependencies = createDependencies();
		vi.mocked(dependencies.downloadAsset).mockRejectedValueOnce(
			new Error('download failed')
		);

		await expect(transferFeishuNoteWithBridge({
			fileContent: '![图](feishu-bridge://image/token-a)',
			notePath: 'Inbox/Test.md',
			behavior: 'create',
			sourceUrl: 'https://tenant.feishu.cn/docx/doc-b',
			vault: 'My Vault',
		}, dependencies)).rejects.toThrow('download failed');
		expect(dependencies.client.abortTransaction).toHaveBeenCalledWith(
			'transaction-1',
			expect.any(AbortSignal)
		);
	});

	test('retries one transient legacy download before committing', async () => {
		const dependencies = createDependencies();
		vi.mocked(dependencies.downloadAsset)
			.mockRejectedValueOnce(new Error('飞书图片下载失败 (HTTP 503)'))
			.mockResolvedValueOnce({
				body: new Uint8Array([0, 1, 2, 3]),
				filename: 'image.png',
				contentType: 'image/png',
				byteLength: 4,
			});
		const retryDelay = vi.fn(async () => undefined);

		await expect(transferFeishuNoteWithBridge({
			fileContent: '![图](feishu-bridge://image/token-a)',
			notePath: 'Inbox/Test.md',
			behavior: 'create',
			sourceUrl: 'https://tenant.feishu.cn/docx/retry',
			vault: 'My Vault',
		}, {
			...dependencies,
			retryDelay,
		} as FeishuBridgeTransferDependencies)).resolves.toMatchObject({
			notePath: 'Inbox/Test.md',
		});
		expect(dependencies.downloadAsset).toHaveBeenCalledTimes(2);
		expect(retryDelay).toHaveBeenCalledOnce();
	});

	test('does not retry a permanent legacy download failure', async () => {
		const dependencies = createDependencies();
		vi.mocked(dependencies.downloadAsset).mockRejectedValue(
			new Error(
				'飞书开放平台媒体下载失败 (HTTP 403, 飞书错误码 99991672: no permission)'
			)
		);
		const retryDelay = vi.fn(async () => undefined);

		await expect(transferFeishuNoteWithBridge({
			fileContent: '![图](feishu-bridge://image/token-a)',
			notePath: 'Inbox/Test.md',
			behavior: 'create',
			sourceUrl: 'https://tenant.feishu.cn/docx/deny',
			vault: 'My Vault',
		}, {
			...dependencies,
			retryDelay,
		} as FeishuBridgeTransferDependencies)).rejects.toThrow('HTTP 403');
		expect(dependencies.downloadAsset).toHaveBeenCalledOnce();
		expect(retryDelay).not.toHaveBeenCalled();
	});

	test('refuses to write into a different active vault', async () => {
		const dependencies = createDependencies();

		await expect(transferFeishuNoteWithBridge({
			fileContent: '![图](feishu-bridge://image/token-a)',
			notePath: 'Inbox/Test.md',
			behavior: 'create',
			sourceUrl: 'https://tenant.feishu.cn/docx/doc-c',
			vault: 'Another Vault',
		}, dependencies)).rejects.toThrow('Vault');
		expect(dependencies.client.createTransaction).not.toHaveBeenCalled();
	});

	test('queues typed remote assets and completes a resumable session', async () => {
		const dependencies = createDependencies();
		const waitingStatus = {
			sessionId: 'session-1',
			phase: 'waiting' as const,
			assetCount: 2,
			completedAssets: 0,
			failedAssets: 0,
			downloadedBytes: 0,
			assets: [
				{
					index: 0,
					kind: 'image' as const,
					state: 'pending' as const,
					byteLength: 0,
				},
				{
					index: 1,
					kind: 'video' as const,
					state: 'pending' as const,
					byteLength: 0,
				},
			],
			updatedAt: new Date().toISOString(),
		};
		const completedStatus = {
			...waitingStatus,
			phase: 'completed' as const,
			completedAssets: 2,
			downloadedBytes: 12,
			notePath: 'Inbox/Test.md',
			assets: [
				{
					index: 0,
					kind: 'image' as const,
					state: 'completed' as const,
					byteLength: 4,
					vaultPath: 'Attachments/image.png',
				},
				{
					index: 1,
					kind: 'video' as const,
					state: 'completed' as const,
					byteLength: 8,
					vaultPath: 'Attachments/video.mp4',
				},
			],
		};
		vi.mocked(dependencies.client.health).mockResolvedValue({
			service: 'clipper-attachment-bridge',
			protocolVersion: 1,
			ready: true,
			vaultName: 'My Vault',
			capabilities: [
				'resumable-remote-media-v1',
			],
		});
		vi.mocked(dependencies.client.createSession).mockResolvedValue({
			sessionId: 'session-1',
			resumed: false,
			status: waitingStatus,
		});
		vi.mocked(dependencies.client.queueSessionAssets).mockResolvedValue({
			...waitingStatus,
			phase: 'downloading',
		});
		vi.mocked(dependencies.client.getSessionStatus).mockResolvedValue(
			completedStatus
		);
		const publishProgress = vi.fn(async () => undefined);
		const resolveAssets = vi.fn(async () => [
			{
				index: 0,
				kind: 'image' as const,
				filename: 'cover',
				downloadUrl: 'https://s1-imfile.feishucdn.com/image',
			},
			{
				index: 1,
				kind: 'video' as const,
				filename: 'video',
				downloadUrl: 'https://s1-imfile.feishucdn.com/video',
			},
		]);

		const result = await transferFeishuNoteWithResumableBridge({
			fileContent: [
				'![封面](feishu-bridge://image/image-token)',
				'![视频](feishu-bridge://video/video-token)',
			].join('\n'),
			notePath: 'Inbox/Test.md',
			behavior: 'create',
			sourceUrl: 'https://tenant.feishu.cn/docx/doc-d',
			vault: 'My Vault',
		}, {
			client: dependencies.client,
			resolveAssets,
			publishProgress,
			pollDelay: async () => undefined,
		});

		expect(result).toEqual({
			notePath: 'Inbox/Test.md',
			assetPaths: [
				'Attachments/image.png',
				'Attachments/video.mp4',
			],
		});
		const createRequest = vi.mocked(
			dependencies.client.createSession
		).mock.calls[0][0];
		expect(createRequest.note.content).toContain('{{FEISHU_BRIDGE_ASSET_0}}');
		expect(JSON.stringify(createRequest)).not.toContain('image-token');
		expect(JSON.stringify(createRequest)).not.toContain('video-token');
		expect(JSON.stringify(createRequest)).not.toContain('private-document');
		expect(resolveAssets).toHaveBeenCalledWith(
			expect.any(Array),
			[0, 1],
			expect.any(String),
			expect.any(AbortSignal)
		);
		expect(publishProgress).toHaveBeenLastCalledWith(
			expect.any(String),
			completedStatus
		);
	});

});
