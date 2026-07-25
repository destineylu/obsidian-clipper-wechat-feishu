import {
	access,
	copyFile,
	mkdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import type { FeishuBridgeCommitResponse } from '../../src/platforms/feishu/bridge-protocol';
import { BridgeProtocolError } from './transaction-store';
import type {
	BridgeTransaction,
	BridgeTransactionWriter,
} from './types';

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function safeRelativePath(rawPath: string): string {
	const path = rawPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
	if (
		!path ||
		/^[a-zA-Z]:/.test(path) ||
		path.split('/').some(segment => !segment || segment === '.' || segment === '..')
	) {
		throw new BridgeProtocolError('unsafe_path', 400, '测试 Vault 路径无效');
	}
	return path;
}

export class E2eFilesystemWriter implements BridgeTransactionWriter {
	private readonly reservations = new Map<string, Set<string>>();
	private readonly reservedPaths = new Set<string>();

	constructor(
		private readonly vaultRoot: string,
		private readonly attachmentFolder = 'Attachments/Web Clipper'
	) {}

	reserveAssetPath(
		transactionId: string,
		index: number,
		filename: string
	): string {
		const safeFilename = safeRelativePath(filename);
		if (safeFilename.includes('/')) {
			throw new BridgeProtocolError('unsafe_filename', 400, '测试附件名无效');
		}
		const extension = extname(safeFilename);
		const stem = safeFilename.slice(0, safeFilename.length - extension.length);
		const suffix =
			transactionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'asset';
		let counter = 0;
		let relativePath = '';
		do {
			relativePath = safeRelativePath(
				`${this.attachmentFolder}/${stem}-${suffix}-${index}${
					counter ? `-${counter}` : ''
				}${extension}`
			);
			counter += 1;
		} while (this.reservedPaths.has(relativePath));

		const transactionPaths =
			this.reservations.get(transactionId) || new Set<string>();
		transactionPaths.add(relativePath);
		this.reservations.set(transactionId, transactionPaths);
		this.reservedPaths.add(relativePath);
		return relativePath;
	}

	release(transactionId: string): void {
		for (const path of this.reservations.get(transactionId) || []) {
			this.reservedPaths.delete(path);
		}
		this.reservations.delete(transactionId);
	}

	async commit(
		transaction: BridgeTransaction,
		content: string
	): Promise<FeishuBridgeCommitResponse> {
		const createdAssetPaths: string[] = [];
		let notePath = safeRelativePath(transaction.request.note.path);
		if (!notePath.toLowerCase().endsWith('.md')) notePath += '.md';
		let absoluteNotePath = join(this.vaultRoot, notePath);
		let originalNote: Buffer | null = null;
		let createdNote = false;

		try {
			for (const asset of [...transaction.assets.values()].sort(
				(left, right) => left.index - right.index
			)) {
				const relativePath = safeRelativePath(asset.vaultPath);
				const destination = join(this.vaultRoot, relativePath);
				if (await pathExists(destination)) {
					throw new BridgeProtocolError(
						'asset_path_conflict',
						409,
						'测试 Vault 附件路径冲突'
					);
				}
				await mkdir(dirname(destination), { recursive: true });
				await copyFile(asset.tempPath, destination);
				createdAssetPaths.push(relativePath);
			}

			if (
				transaction.request.note.behavior === 'create' &&
				await pathExists(absoluteNotePath)
			) {
				const withoutExtension = notePath.replace(/\.md$/i, '');
				let index = 1;
				do {
					notePath = `${withoutExtension}-${index}.md`;
					absoluteNotePath = join(this.vaultRoot, notePath);
					index += 1;
				} while (await pathExists(absoluteNotePath));
			}

			await mkdir(dirname(absoluteNotePath), { recursive: true });
			const noteExists = await pathExists(absoluteNotePath);
			if (noteExists) originalNote = await readFile(absoluteNotePath);
			const behavior = transaction.request.note.behavior;
			const previous = originalNote?.toString('utf8') || '';
			const nextContent = behavior === 'append-specific'
				? `${previous}${content}`
				: behavior === 'prepend-specific'
					? `${content}${previous}`
					: content;
			await writeFile(absoluteNotePath, nextContent, 'utf8');
			createdNote = !noteExists;

			return {
				notePath,
				assetPaths: createdAssetPaths,
			};
		} catch (error) {
			if (originalNote) {
				await writeFile(absoluteNotePath, originalNote).catch(() => undefined);
			} else if (createdNote) {
				await rm(absoluteNotePath, { force: true }).catch(() => undefined);
			}
			await Promise.all(
				createdAssetPaths.map(path =>
					rm(join(this.vaultRoot, path), { force: true })
				)
			);
			throw error;
		}
	}
}
