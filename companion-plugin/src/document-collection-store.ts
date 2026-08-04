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
			for (const [pageId, page] of Object.entries(existing.pages)) {
				if (await this.writer.documentNoteExists(page.path)) continue;
				delete existing.pages[pageId];
			}
			const resumed = !existing.completedAt && Object.keys(existing.pages).length > 0;
			existing.title = request.title;
			existing.totalPages = request.totalPages;
			delete existing.completedAt;
			await this.persist(existing);
			return this.status(existing, resumed, resumed);
		}
		const collection: StoredCollection = { ...request, pages: {} };
		this.collections.set(request.collectionId, collection);
		await this.persist(collection);
		return this.status(collection, false);
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
		const changed = request.notes.filter(note =>
			collection.pages[note.pageId]?.contentHash !== note.contentHash
		);
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
