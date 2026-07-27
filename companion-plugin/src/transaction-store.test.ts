// @vitest-environment node

import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';

import type { FeishuBridgeCreateTransactionRequest } from '../../src/platforms/feishu/bridge-protocol';
import type { BridgeTransactionWriter } from './types';
import { BridgeProtocolError, TransactionStore } from './transaction-store';

const request: FeishuBridgeCreateTransactionRequest = {
	note: {
		path: 'Inbox/Test.md',
		behavior: 'create',
		content: '# Test',
	},
	sourceUrl: 'https://example.com/document',
	assetCount: 1,
};

function createWriter(): BridgeTransactionWriter {
	return {
		reserveAssetPath: vi.fn((_transactionId, index, filename) =>
			`Attachments/${index}-${filename}`
		),
		commit: vi.fn(async transaction => ({
			notePath: transaction.request.note.path,
			assetPaths: [...transaction.assets.values()].map(asset => asset.vaultPath),
		})),
		release: vi.fn(),
	};
}

describe('TransactionStore', () => {
	test('streams an attachment into staging and removes staging after commit', async () => {
		const writer = createWriter();
		const store = new TransactionStore(writer, {
			maxAssetBytes: 20,
			maxTransactionBytes: 40,
			transactionTtlMs: 60_000,
		});
		const transaction = await store.create(request);

		const uploaded = await store.stageAsset(
			transaction.id,
			0,
			Readable.from([Buffer.from([0, 1]), Buffer.from([2, 3])]),
			{
				filename: 'image.png',
				contentType: 'image/png',
				declaredBytes: 4,
			}
		);

		expect(uploaded).toMatchObject({
			index: 0,
			byteLength: 4,
			vaultPath: 'Attachments/0-image.png',
		});
		expect(writer.reserveAssetPath).toHaveBeenCalledWith(
			transaction.id,
			0,
			'image.png',
			'Inbox/Test.md'
		);
		expect(existsSync(transaction.tempDirectory)).toBe(true);

		await expect(store.commit(transaction.id, '# Final')).resolves.toEqual({
			notePath: 'Inbox/Test.md',
			assetPaths: ['Attachments/0-image.png'],
		});
		expect(existsSync(transaction.tempDirectory)).toBe(false);
		expect(writer.release).toHaveBeenCalledWith(transaction.id);
	});

	test('rejects a declared or streamed asset that exceeds its limit', async () => {
		const writer = createWriter();
		const store = new TransactionStore(writer, {
			maxAssetBytes: 3,
			maxTransactionBytes: 10,
			transactionTtlMs: 60_000,
		});
		const declared = await store.create(request);

		await expect(store.stageAsset(
			declared.id,
			0,
			Readable.from([Buffer.from([1])]),
			{
				filename: 'large.png',
				contentType: 'image/png',
				declaredBytes: 4,
			}
		)).rejects.toMatchObject({
			code: 'asset_too_large',
			status: 413,
		});
		await store.abort(declared.id);

		const streamed = await store.create(request);
		await expect(store.stageAsset(
			streamed.id,
			0,
			Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4])]),
			{
				filename: 'large.png',
				contentType: 'image/png',
			}
		)).rejects.toBeInstanceOf(BridgeProtocolError);
		expect(writer.reserveAssetPath).not.toHaveBeenCalled();
		await store.abort(streamed.id);
	});

	test('requires all declared assets before committing', async () => {
		const store = new TransactionStore(createWriter(), {
			maxAssetBytes: 20,
			maxTransactionBytes: 40,
			transactionTtlMs: 60_000,
		});
		const transaction = await store.create({
			...request,
			assetCount: 2,
		});

		await store.stageAsset(
			transaction.id,
			0,
			Readable.from([Buffer.from([1])]),
			{
				filename: 'one.png',
				contentType: 'image/png',
				declaredBytes: 1,
			}
		);

		await expect(store.commit(transaction.id, '# Incomplete')).rejects.toMatchObject({
			code: 'assets_incomplete',
			status: 409,
		});
		await store.abort(transaction.id);
	});
});
