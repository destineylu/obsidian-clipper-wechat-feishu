import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
	mkdtemp,
	open,
	rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import type {
	FeishuBridgeCommitResponse,
	FeishuBridgeCreateTransactionRequest,
	FeishuBridgeUploadAssetResponse,
} from '../../src/platforms/feishu/bridge-protocol';
import type {
	BridgeTransaction,
	BridgeTransactionWriter,
	StagedAsset,
} from './types';

interface TransactionStoreOptions {
	maxAssetBytes: number;
	maxTransactionBytes: number;
	transactionTtlMs: number;
}

interface StageAssetMetadata {
	filename: string;
	contentType: string;
	declaredBytes?: number;
}

export class BridgeProtocolError extends Error {
	constructor(
		public readonly code: string,
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'BridgeProtocolError';
	}
}

function safeFilename(rawFilename: string, index: number): string {
	const decoded = rawFilename
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*#\[\]\u0000-\u001f\u007f]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/^\.+|\.+$/g, '')
		.trim()
		.slice(0, 120);
	return decoded || `asset-${index}.bin`;
}

function stagingFilename(index: number, filename: string): string {
	const digest = createHash('sha256').update(filename).digest('hex').slice(0, 12);
	return `${index}-${digest}.part`;
}

export class TransactionStore {
	private readonly transactions = new Map<string, BridgeTransaction>();

	constructor(
		private readonly writer: BridgeTransactionWriter,
		private readonly options: TransactionStoreOptions
	) {}

	async create(
		request: FeishuBridgeCreateTransactionRequest
	): Promise<BridgeTransaction> {
		this.validateCreateRequest(request);
		await this.purgeExpired();

		const id = randomUUID();
		const expiresAt = new Date(Date.now() + this.options.transactionTtlMs);
		const tempDirectory = await mkdtemp(join(tmpdir(), 'clipper-attachment-bridge-'));
		const transaction: BridgeTransaction = {
			id,
			expiresAt,
			request,
			tempDirectory,
			assets: new Map(),
			totalBytes: 0,
			reservedBytes: 0,
			activeAssetIndexes: new Set(),
		};
		this.transactions.set(id, transaction);
		return transaction;
	}

	async stageAsset(
		transactionId: string,
		index: number,
		stream: Readable,
		metadata: StageAssetMetadata
	): Promise<FeishuBridgeUploadAssetResponse> {
		const transaction = this.getActive(transactionId);
		this.validateAssetIndex(transaction, index);

		const declaredBytes = metadata.declaredBytes;
		if (
			declaredBytes !== undefined &&
			(!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)
		) {
			throw new BridgeProtocolError('invalid_asset_size', 400, '附件大小无效');
		}
		if (declaredBytes !== undefined && declaredBytes > this.options.maxAssetBytes) {
			throw new BridgeProtocolError('asset_too_large', 413, '附件超过单文件大小限制');
		}

		const reservedBytes = declaredBytes ?? this.options.maxAssetBytes;
		if (
			transaction.totalBytes +
				transaction.reservedBytes +
				reservedBytes >
			this.options.maxTransactionBytes
		) {
			throw new BridgeProtocolError(
				'transaction_too_large',
				413,
				'本次保存的附件总量超过限制'
			);
		}

		transaction.reservedBytes += reservedBytes;
		transaction.activeAssetIndexes.add(index);
		const filename = safeFilename(metadata.filename, index);
		const tempPath = join(
			transaction.tempDirectory,
			stagingFilename(index, filename)
		);
		let byteLength = 0;
		const file = await open(tempPath, 'wx');

		try {
			for await (const value of stream) {
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				byteLength += chunk.byteLength;
				if (byteLength > this.options.maxAssetBytes) {
					throw new BridgeProtocolError(
						'asset_too_large',
						413,
						'附件超过单文件大小限制'
					);
				}
				await file.write(chunk);
			}
		} catch (error) {
			await file.close().catch(() => undefined);
			await rm(tempPath, { force: true });
			throw error;
		} finally {
			transaction.reservedBytes -= reservedBytes;
			transaction.activeAssetIndexes.delete(index);
		}

		await file.close();
		if (
			transaction.totalBytes + byteLength >
			this.options.maxTransactionBytes
		) {
			await rm(tempPath, { force: true });
			throw new BridgeProtocolError(
				'transaction_too_large',
				413,
				'本次保存的附件总量超过限制'
			);
		}

		try {
			const vaultPath = this.writer.reserveAssetPath(
				transaction.id,
				index,
				filename,
				transaction.request.note.path
			);
			const asset: StagedAsset = {
				index,
				vaultPath,
				byteLength,
				tempPath,
				filename,
				contentType: metadata.contentType || 'application/octet-stream',
			};
			transaction.assets.set(index, asset);
			transaction.totalBytes += byteLength;
			return {
				index,
				vaultPath,
				byteLength,
			};
		} catch (error) {
			await rm(tempPath, { force: true });
			throw error;
		}
	}

	async commit(
		transactionId: string,
		content: string
	): Promise<FeishuBridgeCommitResponse> {
		const transaction = this.getActive(transactionId);
		if (
			transaction.assets.size !== transaction.request.assetCount ||
			transaction.activeAssetIndexes.size
		) {
			throw new BridgeProtocolError(
				'assets_incomplete',
				409,
				'附件尚未全部上传'
			);
		}

		try {
			return await this.writer.commit(transaction, content);
		} finally {
			await this.deleteTransaction(transaction);
		}
	}

	async abort(transactionId: string): Promise<void> {
		const transaction = this.transactions.get(transactionId);
		if (!transaction) return;
		await this.deleteTransaction(transaction);
	}

	async dispose(): Promise<void> {
		await Promise.all(
			[...this.transactions.values()].map(transaction =>
				this.deleteTransaction(transaction)
			)
		);
	}

	getStagedAssetStream(transactionId: string, index: number) {
		const transaction = this.getActive(transactionId);
		const asset = transaction.assets.get(index);
		if (!asset) {
			throw new BridgeProtocolError('asset_not_found', 404, '未找到附件');
		}
		return createReadStream(asset.tempPath);
	}

	private validateCreateRequest(request: FeishuBridgeCreateTransactionRequest): void {
		if (
			!request ||
			typeof request.sourceUrl !== 'string' ||
			typeof request.note?.path !== 'string' ||
			typeof request.note?.content !== 'string' ||
			!['create', 'overwrite', 'append-specific', 'prepend-specific'].includes(
				request.note?.behavior
			) ||
			!Number.isSafeInteger(request.assetCount) ||
			request.assetCount < 0 ||
			request.assetCount > 1000
		) {
			throw new BridgeProtocolError(
				'invalid_transaction',
				400,
				'保存事务参数无效'
			);
		}
	}

	private validateAssetIndex(transaction: BridgeTransaction, index: number): void {
		if (
			!Number.isSafeInteger(index) ||
			index < 0 ||
			index >= transaction.request.assetCount
		) {
			throw new BridgeProtocolError('invalid_asset_index', 400, '附件序号无效');
		}
		if (
			transaction.assets.has(index) ||
			transaction.activeAssetIndexes.has(index)
		) {
			throw new BridgeProtocolError('asset_conflict', 409, '附件序号已被占用');
		}
	}

	private getActive(transactionId: string): BridgeTransaction {
		const transaction = this.transactions.get(transactionId);
		if (!transaction) {
			throw new BridgeProtocolError('transaction_not_found', 404, '保存事务不存在');
		}
		if (transaction.expiresAt.getTime() <= Date.now()) {
			void this.deleteTransaction(transaction);
			throw new BridgeProtocolError('transaction_expired', 410, '保存事务已过期');
		}
		return transaction;
	}

	private async purgeExpired(): Promise<void> {
		const expired = [...this.transactions.values()].filter(
			transaction => transaction.expiresAt.getTime() <= Date.now()
		);
		await Promise.all(expired.map(transaction => this.deleteTransaction(transaction)));
	}

	private async deleteTransaction(transaction: BridgeTransaction): Promise<void> {
		this.transactions.delete(transaction.id);
		this.writer.release(transaction.id);
		await rm(transaction.tempDirectory, { recursive: true, force: true });
	}
}
