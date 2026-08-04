// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
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
