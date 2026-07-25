import { readFile } from 'node:fs/promises';
import type {
	App,
	TAbstractFile,
	TFile,
} from 'obsidian';

import type { FeishuBridgeCommitResponse } from '../../src/platforms/feishu/bridge-protocol';
import { BridgeProtocolError } from './transaction-store';
import type {
	BridgePluginSettings,
	BridgeTransaction,
	BridgeTransactionWriter,
} from './types';

function normalizeSafeVaultPath(rawPath: string, label: string): string {
	const path = rawPath.replace(/\\/g, '/').trim().replace(/\/+$/, '');
	const segments = path.split('/');
	if (
		!path ||
		path.startsWith('/') ||
		/^[a-zA-Z]:/.test(path) ||
		segments.some(segment => !segment || segment === '.' || segment === '..') ||
		/[\u0000-\u001f|#\[\]]/.test(path)
	) {
		throw new Error(`${label}无效`);
	}
	return path;
}

function isVaultFile(value: TAbstractFile | null): value is TFile {
	return Boolean(value && 'extension' in value && 'basename' in value);
}

function splitExtension(filename: string): { stem: string; extension: string } {
	const match = filename.match(/^(.*?)(\.[^.]+)?$/);
	return {
		stem: match?.[1] || 'asset',
		extension: match?.[2] || '',
	};
}

export class ObsidianVaultWriter implements BridgeTransactionWriter {
	private readonly attachmentFolder: string;
	private readonly reservations = new Map<string, Set<string>>();
	private readonly allReservedPaths = new Set<string>();

	constructor(
		private readonly app: App,
		settings: BridgePluginSettings
	) {
		this.attachmentFolder = normalizeSafeVaultPath(
			settings.attachmentFolder,
			'附件目录'
		);
	}

	validateNotePath(rawPath: string): string {
		const path = normalizeSafeVaultPath(rawPath, '笔记路径');
		return path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
	}

	reserveAssetPath(
		transactionId: string,
		index: number,
		filename: string
	): string {
		const safeFilename = normalizeSafeVaultPath(filename, '附件文件名');
		if (safeFilename.includes('/')) {
			throw new Error('附件文件名无效');
		}
		const { stem, extension } = splitExtension(safeFilename);
		const transactionSuffix =
			transactionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'asset';
		const baseName = `${stem}-${transactionSuffix}-${index}`;
		let suffix = 0;
		let path = '';
		do {
			const candidate = `${baseName}${suffix ? `-${suffix}` : ''}${extension}`;
			path = `${this.attachmentFolder}/${candidate}`;
			suffix += 1;
		} while (
			this.app.vault.getAbstractFileByPath(path) ||
			this.allReservedPaths.has(path)
		);

		let transactionPaths = this.reservations.get(transactionId);
		if (!transactionPaths) {
			transactionPaths = new Set();
			this.reservations.set(transactionId, transactionPaths);
		}
		transactionPaths.add(path);
		this.allReservedPaths.add(path);
		return path;
	}

	release(transactionId: string): void {
		const paths = this.reservations.get(transactionId);
		if (paths) {
			for (const path of paths) this.allReservedPaths.delete(path);
		}
		this.reservations.delete(transactionId);
	}

	async commit(
		transaction: BridgeTransaction,
		content: string
	): Promise<FeishuBridgeCommitResponse> {
		const createdAssets: TFile[] = [];
		let createdNote: TFile | null = null;
		let modifiedNote: { file: TFile; original: string } | null = null;

		try {
			for (const asset of [...transaction.assets.values()].sort(
				(left, right) => left.index - right.index
			)) {
				if (this.app.vault.getAbstractFileByPath(asset.vaultPath)) {
					throw new BridgeProtocolError(
						'asset_path_conflict',
						409,
						'附件路径已被其他文件占用，请重试'
					);
				}
				await this.ensureParentFolders(asset.vaultPath);
				const buffer = await readFile(asset.tempPath);
				const bytes = Uint8Array.from(buffer).buffer;
				createdAssets.push(
					await this.app.vault.createBinary(asset.vaultPath, bytes)
				);
			}

			const requestedNotePath = this.validateNotePath(
				transaction.request.note.path
			);
			await this.ensureParentFolders(requestedNotePath);
			const existing = this.app.vault.getAbstractFileByPath(requestedNotePath);
			const behavior = transaction.request.note.behavior;
			let notePath = requestedNotePath;

			if (behavior === 'create') {
				notePath = this.uniqueNotePath(requestedNotePath);
				createdNote = await this.app.vault.create(notePath, content);
			} else if (existing && !isVaultFile(existing)) {
				throw new BridgeProtocolError(
					'note_path_conflict',
					409,
					'笔记路径被文件夹占用'
				);
			} else if (!existing) {
				createdNote = await this.app.vault.create(notePath, content);
			} else if (behavior === 'overwrite') {
				modifiedNote = {
					file: existing,
					original: await this.app.vault.read(existing),
				};
				await this.app.vault.modify(existing, content);
			} else if (behavior === 'append-specific') {
				modifiedNote = {
					file: existing,
					original: await this.app.vault.read(existing),
				};
				await this.app.vault.process(existing, data => `${data}${content}`);
			} else if (behavior === 'prepend-specific') {
				modifiedNote = {
					file: existing,
					original: await this.app.vault.read(existing),
				};
				await this.app.vault.process(existing, data => `${content}${data}`);
			}

			return {
				notePath,
				assetPaths: [...transaction.assets.values()]
					.sort((left, right) => left.index - right.index)
					.map(asset => asset.vaultPath),
			};
		} catch (error) {
			if (modifiedNote) {
				await this.app.vault
					.modify(modifiedNote.file, modifiedNote.original)
					.catch(() => undefined);
			}
			if (createdNote) {
				await this.app.fileManager.trashFile(createdNote).catch(() => undefined);
			}
			for (const file of createdAssets.reverse()) {
				await this.app.fileManager.trashFile(file).catch(() => undefined);
			}
			throw error;
		}
	}

	private uniqueNotePath(requestedPath: string): string {
		if (!this.app.vault.getAbstractFileByPath(requestedPath)) {
			return requestedPath;
		}
		const withoutExtension = requestedPath.replace(/\.md$/i, '');
		let index = 1;
		let candidate = `${withoutExtension}-${index}.md`;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			index += 1;
			candidate = `${withoutExtension}-${index}.md`;
		}
		return candidate;
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const segments = path.split('/');
		segments.pop();
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}
