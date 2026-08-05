import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
	DocumentCollectionBatchRequest,
	DocumentCollectionCompleteRequest,
	DocumentCollectionCreateRequest,
	DocumentCollectionStatusResponse,
} from '../../src/platforms/feishu/bridge-protocol';
import type { DocumentBundleWriter } from './types';
import { BridgeProtocolError } from './transaction-store';

interface StoredPage {
	path: string;
	contentHash: string;
	sourceUrl?: string;
}

interface StoredCollection extends DocumentCollectionCreateRequest {
	pages: Record<string, StoredPage>;
	completedAt?: string;
}

function normalizeCollectionFolderPath(rawPath: string): string {
	const path = rawPath.replace(/\\/g, '/').trim().replace(/\/+$/, '');
	const segments = path.split('/');
	if (
		!path ||
		path.startsWith('/') ||
		/^[a-zA-Z]:/.test(path) ||
		segments.some(segment => !segment || segment === '.' || segment === '..') ||
		/[\u0000-\u001f|#\[\]]/.test(path)
	) {
		throw new BridgeProtocolError('invalid_document_collection_folder', 400, '文档集合目录无效');
	}
	return path;
}

function parentPath(path: string): string | null {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const separator = normalized.lastIndexOf('/');
	return separator > 0 ? normalized.slice(0, separator) : null;
}

function storedCollectionFolder(collection: StoredCollection): string | null {
	if (collection.folderPath) return normalizeCollectionFolderPath(collection.folderPath);
	const indexFolder = collection.pages.__index__ ? parentPath(collection.pages.__index__.path) : null;
	if (indexFolder) return indexFolder;
	const pageParents = Object.values(collection.pages)
		.map(page => parentPath(page.path))
		.filter((path): path is string => Boolean(path));
	if (pageParents.length === 0) return null;
	const common = pageParents[0].split('/');
	for (const path of pageParents.slice(1)) {
		const segments = path.split('/');
		while (common.length > 0 && common.some((segment, index) => segments[index] !== segment)) {
			common.pop();
		}
	}
	return common.length > 0 ? common.join('/') : null;
}

function migratedPath(path: string, fromFolder: string, toFolder: string): string {
	const normalized = path.replace(/\\/g, '/');
	if (normalized === fromFolder) return toFolder;
	return normalized.startsWith(`${fromFolder}/`)
		? `${toFolder}${normalized.slice(fromFolder.length)}`
		: normalized;
}

export class DocumentCollectionStore {
	private readonly collections = new Map<string, StoredCollection>();

	constructor(
		private readonly writer: DocumentBundleWriter,
		private readonly rootDirectory: string
	) {}

	async initialize(): Promise<void> {
		await mkdir(this.rootDirectory, { recursive: true });
	}

	async create(request: DocumentCollectionCreateRequest): Promise<DocumentCollectionStatusResponse> {
		this.validateMetadata(request);
		const existing = await this.load(request.collectionId);
		if (existing) {
			if (existing.rootUrl !== request.rootUrl || existing.locale !== request.locale) {
				throw new BridgeProtocolError('collection_identity_conflict', 409, '文档集合标识与现有集合不一致');
			}
			const pageEntries = Object.entries(existing.pages);
			for (let offset = 0; offset < pageEntries.length; offset += 100) {
				const chunk = pageEntries.slice(offset, offset + 100);
				const existence = await Promise.all(
					chunk.map(async ([pageId, page]) => ({
						pageId,
						exists: await this.writer.documentNoteExists(page.path),
					}))
				);
				for (const result of existence) {
					if (!result.exists) delete existing.pages[result.pageId];
				}
			}
			const originalFolderPath = existing.folderPath;
			const originalPaths = Object.fromEntries(
				Object.entries(existing.pages).map(([pageId, page]) => [pageId, page.path])
			);
			const currentFolder = storedCollectionFolder(existing);
			const targetFolder = request.folderPath
				? normalizeCollectionFolderPath(request.folderPath)
				: currentFolder;
			let migrated = false;
			try {
				if (
					currentFolder &&
					targetFolder &&
					currentFolder.toLowerCase() !== targetFolder.toLowerCase() &&
					Object.keys(existing.pages).length > 0
				) {
					await this.writer.renameDocumentCollectionFolder(
						currentFolder,
						targetFolder,
						Object.values(existing.pages).map(page => page.path)
					);
					for (const page of Object.values(existing.pages)) {
						page.path = migratedPath(page.path, currentFolder, targetFolder);
					}
					migrated = true;
				}
				const layoutChanged = request.pathLayoutVersion !== undefined &&
					existing.pathLayoutVersion !== request.pathLayoutVersion;
				const resumed = !layoutChanged && !existing.completedAt && Object.keys(existing.pages).length > 0;
				existing.title = request.title;
				existing.totalPages = request.totalPages;
				if (targetFolder) existing.folderPath = targetFolder;
				if (request.pathLayoutVersion !== undefined) {
					existing.pathLayoutVersion = request.pathLayoutVersion;
				}
				delete existing.completedAt;
				await this.persist(existing);
				return this.status(existing, resumed, resumed);
			} catch (error) {
				if (migrated && currentFolder && targetFolder) {
					await this.writer.renameDocumentCollectionFolder(
						targetFolder,
						currentFolder,
						Object.values(existing.pages).map(page => page.path),
						true
					).catch(() => undefined);
					for (const [pageId, path] of Object.entries(originalPaths)) {
						if (existing.pages[pageId]) existing.pages[pageId].path = path;
					}
				}
				if (originalFolderPath) existing.folderPath = originalFolderPath;
				else delete existing.folderPath;
				throw error;
			}
		}
		const collection: StoredCollection = { ...request, pages: {} };
		this.collections.set(request.collectionId, collection);
		await this.persist(collection);
		return this.status(collection, false);
	}

	async getStatus(collectionId: string): Promise<DocumentCollectionStatusResponse> {
		const collection = await this.load(collectionId);
		if (!collection) throw new BridgeProtocolError('collection_not_found', 404, '文档集合不存在');
		const resumed = !collection.completedAt && Object.keys(collection.pages).length > 0;
		return this.status(collection, resumed);
	}

	async complete(
		collectionId: string,
		request?: DocumentCollectionCompleteRequest
	): Promise<DocumentCollectionStatusResponse> {
		const collection = await this.load(collectionId);
		if (!collection) throw new BridgeProtocolError('collection_not_found', 404, '文档集合不存在');
		const requestedPageIds = request?.expectedPageIds || Object.keys(collection.pages)
			.filter(pageId => pageId !== '__index__');
		const expected = [...new Set(requestedPageIds)];
		if (
			expected.length !== requestedPageIds.length ||
			expected.length !== collection.totalPages ||
			expected.some(pageId => !pageId || pageId === '__index__')
		) {
			throw new BridgeProtocolError('invalid_document_completion', 400, '文档集合完成清单无效');
		}
		const missing = expected.filter(pageId => !collection.pages[pageId]);
		if (missing.length > 0 || !collection.pages.__index__) {
			throw new BridgeProtocolError(
				'document_collection_incomplete',
				409,
				`文档集合尚未完整保存（缺少 ${missing.length} 页${collection.pages.__index__ ? '' : '及索引'}）`
			);
		}
		collection.completedAt = new Date().toISOString();
		await this.persist(collection);
		return this.status(collection, true);
	}

	async writeBatch(collectionId: string, request: DocumentCollectionBatchRequest): Promise<DocumentCollectionStatusResponse> {
		const collection = await this.load(collectionId);
		if (!collection) throw new BridgeProtocolError('collection_not_found', 404, '文档集合不存在');
		const changed = request.notes.filter(note => {
			const stored = collection.pages[note.pageId];
			return stored?.contentHash !== note.contentHash || stored?.path !== note.path;
		});
		if (changed.length > 0) {
			const result = await this.writer.commitDocumentCollectionBatch(changed.map(note => ({
				...note,
				ownedPath: collection.pages[note.pageId]?.path,
			})));
			for (let index = 0; index < changed.length; index += 1) {
				const note = changed[index];
				collection.pages[note.pageId] = {
					path: result.notePaths[index],
					contentHash: note.contentHash,
					...(note.sourceUrl ? { sourceUrl: note.sourceUrl } : {}),
				};
			}
			await this.persist(collection);
		}
		return this.status(collection, true);
	}

	private validateMetadata(request: DocumentCollectionCreateRequest): void {
		if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(request.collectionId)) {
			throw new BridgeProtocolError('invalid_collection_id', 400, '文档集合标识无效');
		}
		if (!request.title.trim() || request.title.length > 500 || !request.locale.trim() || request.locale.length > 32) {
			throw new BridgeProtocolError('invalid_collection_metadata', 400, '文档集合信息无效');
		}
		if (request.folderPath !== undefined) normalizeCollectionFolderPath(request.folderPath);
		if (
			request.pathLayoutVersion !== undefined &&
			(!Number.isInteger(request.pathLayoutVersion) || request.pathLayoutVersion < 1)
		) {
			throw new BridgeProtocolError('invalid_path_layout_version', 400, '文档集合路径版本无效');
		}
		try {
			const url = new URL(request.rootUrl);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
		} catch {
			throw new BridgeProtocolError('invalid_collection_url', 400, '文档集合地址无效');
		}
		if (!Number.isInteger(request.totalPages) || request.totalPages < 1 || request.totalPages > 5_000) {
			throw new BridgeProtocolError('invalid_document_count', 400, '文档页面数量无效');
		}
	}

	private async load(collectionId: string): Promise<StoredCollection | null> {
		const cached = this.collections.get(collectionId);
		if (cached) return cached;
		try {
			const collection = JSON.parse(await readFile(this.path(collectionId), 'utf8')) as StoredCollection;
			this.collections.set(collectionId, collection);
			return collection;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	}

	private async persist(collection: StoredCollection): Promise<void> {
		const path = this.path(collection.collectionId);
		const temporary = `${path}.tmp`;
		await writeFile(temporary, JSON.stringify(collection, null, 2), 'utf8');
		await rename(temporary, path);
	}

	private path(collectionId: string): string {
		return join(this.rootDirectory, `${collectionId}.json`);
	}

	private status(collection: StoredCollection, resumed: boolean, exposeCompletedPages = true): DocumentCollectionStatusResponse {
		return {
			collectionId: collection.collectionId,
			resumed,
			totalPages: collection.totalPages,
			completedPageIds: exposeCompletedPages ? Object.keys(collection.pages) : [],
			notePaths: Object.fromEntries(Object.entries(collection.pages).map(([id, page]) => [id, page.path])),
			completed: Boolean(collection.completedAt),
		};
	}
}
