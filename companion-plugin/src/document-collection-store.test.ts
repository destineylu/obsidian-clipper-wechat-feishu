// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DocumentCollectionStore } from './document-collection-store';
import type { DocumentBundleWriter } from './types';

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function writer(existingPaths?: Set<string>): DocumentBundleWriter {
	return {
		documentNoteExists: vi.fn(async path => existingPaths?.has(path) ?? true),
		renameDocumentCollectionFolder: vi.fn(async () => undefined),
		commitDocumentBundle: vi.fn(async request => ({ notePaths: request.notes.map(note => note.path) })),
		commitDocumentCollectionBatch: vi.fn(async notes => ({
			notePaths: notes.map(note => note.ownedPath || note.path),
		})),
	};
}

describe('DocumentCollectionStore', () => {
	test('persists checkpoints, skips unchanged pages, and preserves removed pages', async () => {
		const root = await mkdtemp(join(tmpdir(), 'document-collections-'));
		directories.push(root);
		const firstWriter = writer();
		const first = new DocumentCollectionStore(firstWriter, root);
		await first.initialize();
		await first.create({
			collectionId: 'llms-txt-12345678',
			title: 'Docs',
			rootUrl: 'https://example.com/docs/en/',
			locale: 'en',
			totalPages: 2,
		});
		await first.writeBatch('llms-txt-12345678', { notes: [{
			pageId: 'intro', path: 'Docs/Intro.md', content: '# Intro', contentHash: '12345678',
		}] });
		await expect(first.getStatus('llms-txt-12345678')).resolves.toMatchObject({
			resumed: true,
			completedPageIds: ['intro'],
			completed: false,
			notePaths: { intro: 'Docs/Intro.md' },
		});

		const secondWriter = writer();
		const second = new DocumentCollectionStore(secondWriter, root);
		await second.initialize();
		const resumed = await second.create({
			collectionId: 'llms-txt-12345678',
			title: 'Docs',
			rootUrl: 'https://example.com/docs/en/',
			locale: 'en',
			totalPages: 1,
		});
		expect(resumed).toMatchObject({ resumed: true, completedPageIds: ['intro'] });

		await second.writeBatch('llms-txt-12345678', { notes: [{
			pageId: 'intro', path: 'Docs/Intro.md', content: '# Intro', contentHash: '12345678',
		}] });
		expect(secondWriter.commitDocumentCollectionBatch).not.toHaveBeenCalled();
		expect(resumed.notePaths.intro).toBe('Docs/Intro.md');

		await second.writeBatch('llms-txt-12345678', { notes: [{
			pageId: '__index__', path: 'Docs/00 - Documentation index.md',
			content: '# Docs', contentHash: '87654321',
		}] });
		await second.complete('llms-txt-12345678');
		const nextSync = await second.create({
			collectionId: 'llms-txt-12345678', title: 'Docs',
			rootUrl: 'https://example.com/docs/en/', locale: 'en', totalPages: 1,
		});
		expect(nextSync).toMatchObject({ resumed: false, completedPageIds: [], completed: false });
		expect(nextSync.notePaths.intro).toBe('Docs/Intro.md');
	});

	test('forces a full path refresh when the ordered layout version changes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'document-collections-'));
		directories.push(root);
		const collectionWriter = writer();
		vi.mocked(collectionWriter.commitDocumentCollectionBatch).mockImplementation(async notes => ({
			notePaths: notes.map(note => note.path),
		}));
		const store = new DocumentCollectionStore(collectionWriter, root);
		await store.initialize();
		await store.create({
			collectionId: 'llms-txt-layout1', title: 'Docs',
			rootUrl: 'https://example.com/docs/', locale: 'en', totalPages: 1,
		});
		await store.writeBatch('llms-txt-layout1', { notes: [{
			pageId: 'intro', path: 'Docs/Intro.md', content: '# Intro', contentHash: '12345678',
		}] });

		const refreshed = await store.create({
			collectionId: 'llms-txt-layout1', title: 'Docs',
			rootUrl: 'https://example.com/docs/', locale: 'en', totalPages: 1,
			pathLayoutVersion: 2,
		});
		expect(refreshed).toMatchObject({ resumed: false, completedPageIds: [] });

		await store.writeBatch('llms-txt-layout1', { notes: [{
			pageId: 'intro', path: 'Docs/01 - Intro.md', content: '# Intro', contentHash: '12345678',
		}] });
		expect(collectionWriter.commitDocumentCollectionBatch).toHaveBeenLastCalledWith([{
			pageId: 'intro', path: 'Docs/01 - Intro.md', ownedPath: 'Docs/Intro.md',
			content: '# Intro', contentHash: '12345678',
		}]);
	});

	test('resumes and completes a 680-page collection after the client misses the final response', async () => {
		const root = await mkdtemp(join(tmpdir(), 'document-collections-'));
		directories.push(root);
		const collectionWriter = writer();
		const store = new DocumentCollectionStore(collectionWriter, root);
		await store.initialize();
		const pageIds = Array.from({ length: 680 }, (_, index) => `page-${index + 1}`);
		const request = {
			collectionId: 'llms-txt-generic-openai',
			title: 'OpenAI Developers',
			rootUrl: 'https://developers.openai.com/',
			locale: 'en',
			totalPages: pageIds.length,
			folderPath: 'Clippings/OpenAI Developers',
			pathLayoutVersion: 2,
		};
		await store.create(request);
		await store.writeBatch(request.collectionId, {
			notes: [
				...pageIds.map((pageId, index) => ({
					pageId,
					path: `Clippings/OpenAI Developers/${String(index + 1).padStart(3, '0')} - Page.md`,
					content: `# Page ${index + 1}`,
					contentHash: String(index + 1).padStart(8, '0'),
				})),
				{
					pageId: '__index__',
					path: 'Clippings/OpenAI Developers/00 - Documentation index.md',
					content: '# OpenAI Developers',
					contentHash: '87654321',
				},
			],
		});

		const resumed = await store.create(request);
		expect(resumed.resumed).toBe(true);
		expect(resumed.completedPageIds).toHaveLength(681);
		expect(collectionWriter.documentNoteExists).toHaveBeenCalledTimes(681);
		await expect(store.complete(request.collectionId, { expectedPageIds: pageIds })).resolves.toMatchObject({
			completed: true,
			totalPages: 680,
		});
	});

	test('migrates every owned note when a corrected collection title changes its folder', async () => {
		const root = await mkdtemp(join(tmpdir(), 'document-collections-'));
		directories.push(root);
		const collectionWriter = writer();
		const store = new DocumentCollectionStore(collectionWriter, root);
		await store.initialize();
		await store.create({
			collectionId: 'docusaurus-12345678',
			title: '产品概览',
			rootUrl: 'https://joycode.jd.com/docs/',
			locale: 'en',
			totalPages: 1,
			folderPath: 'Clippings/产品概览',
		});
		await store.writeBatch('docusaurus-12345678', { notes: [
			{
				pageId: 'overview',
				path: 'Clippings/产品概览/start/产品概览.md',
				content: '# 产品概览',
				contentHash: '12345678',
			},
			{
				pageId: '__index__',
				path: 'Clippings/产品概览/00 - Documentation index.md',
				content: '# 产品概览',
				contentHash: '87654321',
			},
		] });
		await store.complete('docusaurus-12345678', { expectedPageIds: ['overview'] });

		const renamed = await store.create({
			collectionId: 'docusaurus-12345678',
			title: 'JoyCode',
			rootUrl: 'https://joycode.jd.com/docs/',
			locale: 'en',
			totalPages: 1,
			folderPath: 'Clippings/JoyCode',
		});

		expect(collectionWriter.renameDocumentCollectionFolder).toHaveBeenCalledWith(
			'Clippings/产品概览',
			'Clippings/JoyCode',
			[
				'Clippings/产品概览/start/产品概览.md',
				'Clippings/产品概览/00 - Documentation index.md',
			]
		);
		expect(renamed.notePaths).toEqual({
			overview: 'Clippings/JoyCode/start/产品概览.md',
			__index__: 'Clippings/JoyCode/00 - Documentation index.md',
		});
		const persisted = JSON.parse(await readFile(
			join(root, 'docusaurus-12345678.json'),
			'utf8'
		)) as { title: string; folderPath: string; pages: Record<string, { path: string }> };
		expect(persisted.title).toBe('JoyCode');
		expect(persisted.folderPath).toBe('Clippings/JoyCode');
		expect(persisted.pages.overview.path).toBe('Clippings/JoyCode/start/产品概览.md');
	});

	test('refuses to complete until every expected page and the index are persisted', async () => {
		const root = await mkdtemp(join(tmpdir(), 'document-collections-'));
		directories.push(root);
		const store = new DocumentCollectionStore(writer(), root);
		await store.initialize();
		await store.create({
			collectionId: 'google-devsite-12345678', title: 'Gemini',
			rootUrl: 'https://ai.google.dev/gemini-api/docs/', locale: 'zh-cn', totalPages: 2,
		});
		await store.writeBatch('google-devsite-12345678', { notes: [{
			pageId: 'intro', path: 'Gemini/Intro.md', content: '# Intro', contentHash: '12345678',
		}] });
		await expect(store.complete('google-devsite-12345678', {
			expectedPageIds: ['intro', 'models'],
		})).rejects.toMatchObject({ code: 'document_collection_incomplete', status: 409 });

		await store.writeBatch('google-devsite-12345678', { notes: [
			{ pageId: 'models', path: 'Gemini/Models.md', content: '# Models', contentHash: 'abcdef12' },
			{ pageId: '__index__', path: 'Gemini/00 - Documentation index.md', content: '# Gemini', contentHash: '87654321' },
		] });
		await expect(store.complete('google-devsite-12345678', {
			expectedPageIds: ['intro', 'models'],
		})).resolves.toMatchObject({ completed: true });
	});

	test('removes deleted generated notes from the resume checkpoint', async () => {
		const root = await mkdtemp(join(tmpdir(), 'document-collections-'));
		directories.push(root);
		const first = new DocumentCollectionStore(writer(), root);
		await first.initialize();
		await first.create({
			collectionId: 'google-devsite-deleted1', title: 'Gemini',
			rootUrl: 'https://ai.google.dev/gemini-api/docs/', locale: 'zh-cn', totalPages: 2,
		});
		await first.writeBatch('google-devsite-deleted1', { notes: [
			{ pageId: 'intro', path: 'Gemini/Intro.md', content: '# Intro', contentHash: '12345678' },
			{ pageId: 'models', path: 'Gemini/Models.md', content: '# Models', contentHash: 'abcdef12' },
		] });

		const second = new DocumentCollectionStore(writer(new Set(['Gemini/Models.md'])), root);
		await second.initialize();
		await expect(second.create({
			collectionId: 'google-devsite-deleted1', title: 'Gemini',
			rootUrl: 'https://ai.google.dev/gemini-api/docs/', locale: 'zh-cn', totalPages: 2,
		})).resolves.toMatchObject({
			resumed: true,
			completedPageIds: ['models'],
			notePaths: { models: 'Gemini/Models.md' },
		});
	});
});
