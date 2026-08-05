import { readFile } from 'node:fs/promises';
import type {
	App,
	TAbstractFile,
	TFile,
	TFolder,
} from 'obsidian';

import type {
	DocumentBundleWriteRequest,
	DocumentBundleWriteResponse,
	DocumentCollectionNoteRequest,
	FeishuBridgeCommitResponse,
} from '../../src/platforms/feishu/bridge-protocol';
import { BridgeProtocolError } from './transaction-store';
import type {
	BridgePluginSettings,
	BridgeTransaction,
	BridgeTransactionWriter,
	DocumentBundleWriter,
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

function isVaultFolder(value: TAbstractFile | null): value is TFolder {
	return Boolean(value && 'children' in value && !('extension' in value));
}

function parentFolderPath(path: string): string | null {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const separator = normalized.lastIndexOf('/');
	return separator > 0 ? normalized.slice(0, separator) : null;
}

function commonParentFolder(leftPath: string, rightPath: string): string | null {
	const left = (parentFolderPath(leftPath) || '').split('/').filter(Boolean);
	const right = (parentFolderPath(rightPath) || '').split('/').filter(Boolean);
	const common: string[] = [];
	for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
		if (left[index] !== right[index]) break;
		common.push(left[index]);
	}
	return common.length > 0 ? common.join('/') : null;
}

function splitExtension(filename: string): { stem: string; extension: string } {
	const match = filename.match(/^(.*?)(\.[^.]+)?$/);
	return {
		stem: match?.[1] || 'asset',
		extension: match?.[2] || '',
	};
}

function attachmentFolderForNote(rawNotePath: string): string {
	const normalizedPath = rawNotePath.replace(/\\/g, '/').trim();
	const rawName = normalizedPath.split('/').pop()?.replace(/\.md$/i, '') || '';
	const safeName = rawName
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*#\[\]\u0000-\u001f\u007f]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/^\.+|\.+$/g, '')
		.trim()
		.slice(0, 100);
	return safeName || '未命名笔记';
}

export class ObsidianVaultWriter implements BridgeTransactionWriter, DocumentBundleWriter {
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
		filename: string,
		notePath: string
	): string {
		const safeFilename = normalizeSafeVaultPath(
			filename.replace(/[#\[\]]/g, '-'),
			'附件文件名'
		);
		if (safeFilename.includes('/')) {
			throw new Error('附件文件名无效');
		}
		const { stem, extension } = splitExtension(safeFilename);
		const transactionSuffix =
			transactionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'asset';
		const baseName = `${stem}-${transactionSuffix}-${index}`;
		const noteFolder = attachmentFolderForNote(notePath);
		let suffix = 0;
		let path = '';
		do {
			const candidate = `${baseName}${suffix ? `-${suffix}` : ''}${extension}`;
			path = `${this.attachmentFolder}/${noteFolder}/${candidate}`;
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

	async commitDocumentBundle(
		request: DocumentBundleWriteRequest
	): Promise<DocumentBundleWriteResponse> {
		const createdNotes: TFile[] = [];
		const modifiedNotes: Array<{ file: TFile; original: string }> = [];
		const prepared = request.notes.map(note => {
			const path = this.validateNotePath(note.path);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing && !isVaultFile(existing)) {
				throw new BridgeProtocolError(
					'note_path_conflict',
					409,
					'笔记路径被文件夹占用'
				);
			}
			return { ...note, path, existing };
		});

		try {
			for (const note of prepared) {
				await this.ensureParentFolders(note.path);
				if (note.existing) {
					modifiedNotes.push({
						file: note.existing,
						original: await this.app.vault.read(note.existing),
					});
					await this.app.vault.modify(note.existing, note.content);
				} else {
					createdNotes.push(await this.app.vault.create(note.path, note.content));
				}
			}
			return { notePaths: prepared.map(note => note.path) };
		} catch (error) {
			for (const note of [...modifiedNotes].reverse()) {
				await this.app.vault.modify(note.file, note.original).catch(() => undefined);
			}
			for (const note of [...createdNotes].reverse()) {
				await this.app.fileManager.trashFile(note).catch(() => undefined);
			}
			throw error;
		}
	}

	async commitDocumentCollectionBatch(
		notes: Array<DocumentCollectionNoteRequest & { ownedPath?: string }>
	): Promise<DocumentBundleWriteResponse> {
		const createdNotes: TFile[] = [];
		const modifiedNotes: Array<{ file: TFile; original: string }> = [];
		const movedNotes: Array<{ from: string; to: string }> = [];
		const batchPaths = new Set<string>();
		const prepared = notes.map(note => {
			const requestedPath = this.validateNotePath(note.path);
			const ownedPath = note.ownedPath ? this.validateNotePath(note.ownedPath) : undefined;
			const path = ownedPath || this.uniqueNotePath(requestedPath, batchPaths);
			const requestedTarget = ownedPath && ownedPath.toLowerCase() !== requestedPath.toLowerCase()
				? this.app.vault.getAbstractFileByPath(requestedPath)
				: null;
			const finalPath = ownedPath && ownedPath.toLowerCase() !== requestedPath.toLowerCase() && !requestedTarget
				? requestedPath
				: path;
			const pathKey = finalPath.toLowerCase();
			if (batchPaths.has(pathKey)) {
				throw new BridgeProtocolError('duplicate_owned_note_path', 409, '文档集合笔记归属路径重复');
			}
			batchPaths.add(pathKey);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (ownedPath && !isVaultFile(existing)) {
				throw new BridgeProtocolError('document_collection_note_not_found', 404, '文档集合笔记不存在');
			}
			if (existing && !isVaultFile(existing)) {
				throw new BridgeProtocolError('note_path_conflict', 409, '笔记路径被文件夹占用');
			}
			return { ...note, path: finalPath, existing, moveFrom: finalPath !== path ? path : undefined };
		});
		try {
			for (const note of prepared) {
				await this.ensureParentFolders(note.path);
				let existing = note.existing;
				if (existing && note.moveFrom) {
					await this.app.fileManager.renameFile(existing, note.path);
					movedNotes.push({ from: note.moveFrom, to: note.path });
					const moved = this.app.vault.getAbstractFileByPath(note.path);
					if (!isVaultFile(moved)) throw new Error('文档集合笔记移动失败');
					existing = moved;
				}
				if (existing) {
					modifiedNotes.push({ file: existing, original: await this.app.vault.read(existing) });
					await this.app.vault.modify(existing, note.content);
				} else {
					createdNotes.push(await this.app.vault.create(note.path, note.content));
				}
			}
			for (const move of movedNotes) {
				const stopFolder = commonParentFolder(move.from, move.to);
				if (stopFolder) await this.removeEmptyParentFolders(move.from, stopFolder);
			}
			return { notePaths: prepared.map(note => note.path) };
		} catch (error) {
			for (const note of [...modifiedNotes].reverse()) {
				await this.app.vault.modify(note.file, note.original).catch(() => undefined);
			}
			for (const note of [...createdNotes].reverse()) {
				await this.app.fileManager.trashFile(note).catch(() => undefined);
			}
			for (const move of [...movedNotes].reverse()) {
				const file = this.app.vault.getAbstractFileByPath(move.to);
				if (!isVaultFile(file)) continue;
				await this.ensureParentFolders(move.from).catch(() => undefined);
				await this.app.fileManager.renameFile(file, move.from).catch(() => undefined);
			}
			throw error;
		}
	}

	private uniqueNotePath(requestedPath: string, reservedPaths = new Set<string>()): string {
		if (!this.app.vault.getAbstractFileByPath(requestedPath) && !reservedPaths.has(requestedPath.toLowerCase())) {
			return requestedPath;
		}
		const withoutExtension = requestedPath.replace(/\.md$/i, '');
		let index = 1;
		let candidate = `${withoutExtension}-${index}.md`;
		while (this.app.vault.getAbstractFileByPath(candidate) || reservedPaths.has(candidate.toLowerCase())) {
			index += 1;
			candidate = `${withoutExtension}-${index}.md`;
		}
		return candidate;
	}

	async documentNoteExists(rawPath: string): Promise<boolean> {
		const path = this.validateNotePath(rawPath);
		return isVaultFile(this.app.vault.getAbstractFileByPath(path));
	}

	async renameDocumentCollectionFolder(
		rawFromPath: string,
		rawToPath: string,
		ownedNotePaths: string[],
		allowExistingTarget = false
	): Promise<void> {
		let fromPath: string;
		let toPath: string;
		let ownedPaths: string[];
		try {
			fromPath = normalizeSafeVaultPath(rawFromPath, '原文档集合目录');
			toPath = normalizeSafeVaultPath(rawToPath, '目标文档集合目录');
			ownedPaths = ownedNotePaths.map(path => this.validateNotePath(path));
		} catch (error) {
			throw new BridgeProtocolError(
				'invalid_document_collection_folder',
				400,
				error instanceof Error ? error.message : '文档集合目录无效'
			);
		}
		if (fromPath.toLowerCase() === toPath.toLowerCase()) return;
		if (ownedPaths.some(path => !path.startsWith(`${fromPath}/`))) {
			throw new BridgeProtocolError(
				'invalid_document_collection_folder',
				400,
				'文档集合包含目录外的笔记'
			);
		}
		const source = this.app.vault.getAbstractFileByPath(fromPath);
		if (!isVaultFolder(source)) {
			throw new BridgeProtocolError(
				'document_collection_folder_not_found',
				404,
				'原文档集合目录不存在'
			);
		}
		const target = this.app.vault.getAbstractFileByPath(toPath);
		if (target && (!allowExistingTarget || !isVaultFolder(target))) {
			throw new BridgeProtocolError(
				'document_collection_folder_conflict',
				409,
				'目标文档集合目录已存在'
			);
		}

		const ownedPathKeys = new Set(ownedPaths.map(path => path.toLowerCase()));
		const sourceFiles = this.app.vault.getFiles().filter(file =>
			file.path.startsWith(`${fromPath}/`)
		);
		const containsUnownedFiles = sourceFiles.some(file =>
			!ownedPathKeys.has(file.path.toLowerCase())
		);
		if (!containsUnownedFiles && !target) {
			const segments = toPath.split('/');
			segments.pop();
			let parent = '';
			for (const segment of segments) {
				parent = parent ? `${parent}/${segment}` : segment;
				if (!this.app.vault.getAbstractFileByPath(parent)) {
					await this.app.vault.createFolder(parent);
				}
			}
			await this.app.fileManager.renameFile(source, toPath);
			return;
		}

		const moves = ownedPaths.map(path => ({
			from: path,
			to: `${toPath}${path.slice(fromPath.length)}`,
		}));
		for (const move of moves) {
			if (!isVaultFile(this.app.vault.getAbstractFileByPath(move.from))) {
				throw new BridgeProtocolError(
					'document_collection_note_not_found',
					404,
					'文档集合笔记不存在'
				);
			}
			if (this.app.vault.getAbstractFileByPath(move.to)) {
				throw new BridgeProtocolError(
					'document_collection_folder_conflict',
					409,
					'目标文档集合目录包含同名笔记'
				);
			}
		}
		const moved: typeof moves = [];
		try {
			for (const move of moves) {
				const file = this.app.vault.getAbstractFileByPath(move.from);
				if (!isVaultFile(file)) throw new Error('文档集合笔记不存在');
				await this.ensureParentFolders(move.to);
				await this.app.fileManager.renameFile(file, move.to);
				moved.push(move);
			}
		} catch (error) {
			for (const move of [...moved].reverse()) {
				const file = this.app.vault.getAbstractFileByPath(move.to);
				if (!isVaultFile(file)) continue;
				await this.ensureParentFolders(move.from).catch(() => undefined);
				await this.app.fileManager.renameFile(file, move.from).catch(() => undefined);
			}
			throw error;
		}
	}

	private async removeEmptyParentFolders(filePath: string, stopFolder: string): Promise<void> {
		let folderPath = parentFolderPath(filePath);
		while (folderPath && folderPath !== stopFolder) {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!isVaultFolder(folder) || folder.children.length > 0) return;
			await this.app.vault.delete(folder, true);
			folderPath = parentFolderPath(folderPath);
		}
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
