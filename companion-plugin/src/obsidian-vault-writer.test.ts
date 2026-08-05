// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { App, TAbstractFile, TFile } from 'obsidian';

import type {
	BridgePluginSettings,
	BridgeTransaction,
} from './types';
import { DEFAULT_BRIDGE_SETTINGS } from './config';
import { ObsidianVaultWriter } from './obsidian-vault-writer';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(path =>
			rm(path, { recursive: true, force: true })
		)
	);
});

function createFakeApp() {
	const files = new Map<string, {
		file: TFile;
		text?: string;
		binary?: Uint8Array;
	}>();
	const folders = new Set<string>();
	const asFile = (path: string) => ({
		path,
		name: path.split('/').at(-1) || path,
		extension: path.split('.').at(-1) || '',
		parent: null,
		vault: null,
		stat: { ctime: 0, mtime: 0, size: 0 },
		basename: (path.split('/').at(-1) || path).replace(/\.[^.]+$/, ''),
	}) as unknown as TFile;
	const asFolder = (path: string) => ({
		path,
		name: path.split('/').at(-1) || path,
		parent: null,
		vault: null,
		children: [],
	});

	const vault = {
		getName: () => 'Test Vault',
		getFiles: () => [...files.values()].map(item => item.file),
		getAbstractFileByPath: vi.fn((path: string): TAbstractFile | null =>
			files.get(path)?.file || (folders.has(path) ? asFolder(path) as unknown as TAbstractFile : null)
		),
		createFolder: vi.fn(async (path: string) => {
			folders.add(path);
			return { path };
		}),
		createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
			const file = asFile(path);
			files.set(path, {
				file,
				binary: new Uint8Array(data),
			});
			return file;
		}),
		create: vi.fn(async (path: string, text: string) => {
			const file = asFile(path);
			files.set(path, { file, text });
			return file;
		}),
		modify: vi.fn(async (file: TFile, text: string) => {
			const item = files.get(file.path);
			if (item) item.text = text;
		}),
		process: vi.fn(async (file: TFile, update: (data: string) => string) => {
			const item = files.get(file.path);
			if (!item) throw new Error('missing');
			item.text = update(item.text || '');
			return item.text;
		}),
		read: vi.fn(async (file: TFile) => files.get(file.path)?.text || ''),
		delete: vi.fn(async (entry: TAbstractFile) => {
			folders.delete(entry.path);
		}),
	};
	const fileManager = {
		trashFile: vi.fn(async (file: TFile) => {
			files.delete(file.path);
		}),
		renameFile: vi.fn(async (entry: TAbstractFile, targetPath: string) => {
			const sourcePath = entry.path;
			if (files.has(sourcePath)) {
				const item = files.get(sourcePath)!;
				files.delete(sourcePath);
				files.set(targetPath, { ...item, file: asFile(targetPath) });
				return;
			}
			const movedFiles = [...files.entries()]
				.filter(([path]) => path.startsWith(`${sourcePath}/`));
			for (const [path, item] of movedFiles) {
				const nextPath = `${targetPath}${path.slice(sourcePath.length)}`;
				files.delete(path);
				files.set(nextPath, { ...item, file: asFile(nextPath) });
			}
			const movedFolders = [...folders]
				.filter(path => path === sourcePath || path.startsWith(`${sourcePath}/`));
			for (const path of movedFolders) folders.delete(path);
			for (const path of movedFolders) {
				folders.add(`${targetPath}${path.slice(sourcePath.length)}`);
			}
		}),
	};
	return {
		app: { vault, fileManager } as unknown as App,
		files,
		folders,
		vault,
		fileManager,
	};
}

const settings: BridgePluginSettings = {
	...DEFAULT_BRIDGE_SETTINGS,
	pairingTokenHash: 'hash',
};

describe('ObsidianVaultWriter', () => {
	test('writes exact binary bytes and creates a portable note', async () => {
		const fake = createFakeApp();
		const tempDirectory = await mkdtemp(join(tmpdir(), 'bridge-writer-test-'));
		temporaryDirectories.push(tempDirectory);
		const tempPath = join(tempDirectory, 'asset.part');
		await writeFile(tempPath, Buffer.from([0, 1, 2, 255]));
		const writer = new ObsidianVaultWriter(fake.app, settings);
		const vaultPath = writer.reserveAssetPath(
			'transaction-12345678',
			0,
			'image.png',
			'Inbox/Test.md'
		);
		const transaction: BridgeTransaction = {
			id: 'transaction-12345678',
			expiresAt: new Date(Date.now() + 60_000),
			request: {
				note: {
					path: 'Inbox/Test.md',
					behavior: 'create',
					content: '# Draft',
				},
				sourceUrl: 'https://example.com',
				assetCount: 1,
			},
			tempDirectory,
			assets: new Map([[
				0,
				{
					index: 0,
					vaultPath,
					byteLength: 4,
					tempPath,
					filename: 'image.png',
					contentType: 'image/png',
				},
			]]),
			totalBytes: 4,
			reservedBytes: 0,
			activeAssetIndexes: new Set(),
		};

		expect(vaultPath).toBe(
			'Attachments/Web Clipper/Test/image-transact-0.png'
		);
		await expect(writer.commit(
			transaction,
			`# Final\n\n![[${vaultPath}]]`
		)).resolves.toEqual({
			notePath: 'Inbox/Test.md',
			assetPaths: [vaultPath],
		});

		expect([...fake.files.get(vaultPath)!.binary!]).toEqual([0, 1, 2, 255]);
		expect(fake.files.get('Inbox/Test.md')?.text).toContain(vaultPath);
		expect(fake.folders).toEqual(new Set([
			'Attachments',
			'Attachments/Web Clipper',
			'Attachments/Web Clipper/Test',
			'Inbox',
		]));
	});

	test('rejects traversal in note and attachment settings', () => {
		const fake = createFakeApp();
		expect(() => new ObsidianVaultWriter(fake.app, {
			...settings,
			attachmentFolder: '../outside',
		})).toThrow('附件目录');

		const writer = new ObsidianVaultWriter(fake.app, settings);
		expect(() => writer.validateNotePath('../outside.md')).toThrow('笔记路径');
	});

	test('sanitizes Markdown-sensitive characters in attachment filenames', () => {
		const fake = createFakeApp();
		const writer = new ObsidianVaultWriter(fake.app, settings);

		expect(writer.reserveAssetPath(
			'transaction-12345678',
			2,
			'## scene [01].mp4',
			'Clippings/教程 #1 [测试].md'
		)).toBe(
			'Attachments/Web Clipper/教程 -1 -测试-/-- scene -01--transact-2.mp4'
		);
	});

	test('writes a document bundle and rolls every change back on failure', async () => {
		const fake = createFakeApp();
		await fake.vault.create('Docs/Existing.md', '# Original');
		const writer = new ObsidianVaultWriter(fake.app, settings);

		await expect(writer.commitDocumentBundle({
			behavior: 'overwrite',
			notes: [
				{ path: 'Docs/Existing.md', content: '# Updated' },
				{ path: 'Docs/New.md', content: '# New' },
			],
		})).resolves.toEqual({
			notePaths: ['Docs/Existing.md', 'Docs/New.md'],
		});
		expect(fake.files.get('Docs/Existing.md')?.text).toBe('# Updated');
		expect(fake.files.get('Docs/New.md')?.text).toBe('# New');

		const originalCreate = fake.vault.create.getMockImplementation();
		fake.vault.create.mockImplementation(async (path: string, text: string) => {
			if (path.endsWith('Failure.md')) throw new Error('disk full');
			return originalCreate!(path, text);
		});
		await expect(writer.commitDocumentBundle({
			behavior: 'overwrite',
			notes: [
				{ path: 'Docs/Existing.md', content: '# Broken update' },
				{ path: 'Docs/Created-before-failure.md', content: '# Temporary' },
				{ path: 'Docs/Failure.md', content: '# Failure' },
			],
		})).rejects.toThrow('disk full');

		expect(fake.files.get('Docs/Existing.md')?.text).toBe('# Updated');
		expect(fake.files.has('Docs/Created-before-failure.md')).toBe(false);
	});

	test('renames an owned documentation folder without overwriting an existing target', async () => {
		const fake = createFakeApp();
		const writer = new ObsidianVaultWriter(fake.app, settings);
		await writer.commitDocumentCollectionBatch([
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
		]);

		await fake.vault.create('Clippings/产品概览/用户笔记.md', '# User note');
		await expect(writer.renameDocumentCollectionFolder(
			'Clippings/产品概览',
			'Clippings/JoyCode',
			[
				'Clippings/产品概览/start/产品概览.md',
				'Clippings/产品概览/00 - Documentation index.md',
			]
		)).resolves.toBeUndefined();
		expect(fake.files.has('Clippings/产品概览/start/产品概览.md')).toBe(false);
		expect(fake.files.get('Clippings/JoyCode/start/产品概览.md')?.text).toBe('# 产品概览');
		expect(fake.files.get('Clippings/JoyCode/00 - Documentation index.md')?.text).toBe('# 产品概览');
		expect(fake.files.get('Clippings/产品概览/用户笔记.md')?.text).toBe('# User note');

		await fake.vault.createFolder('Clippings/Existing');
		await expect(writer.renameDocumentCollectionFolder(
			'Clippings/JoyCode',
			'Clippings/Existing',
			[
				'Clippings/JoyCode/start/产品概览.md',
				'Clippings/JoyCode/00 - Documentation index.md',
			]
		)).rejects.toMatchObject({
			code: 'document_collection_folder_conflict',
			status: 409,
		});
	});

	test('moves an owned note to its ordered path, updates it, and removes empty old folders', async () => {
		const fake = createFakeApp();
		await fake.vault.createFolder('Docs');
		await fake.vault.createFolder('Docs/guide');
		await fake.vault.create('Docs/guide/Guide.md', '# Old');
		const writer = new ObsidianVaultWriter(fake.app, settings);

		await expect(writer.commitDocumentCollectionBatch([{
			pageId: 'guide',
			path: 'Docs/01 - guide/01 - Guide.md',
			ownedPath: 'Docs/guide/Guide.md',
			content: '# Updated',
			contentHash: 'abcdef12',
		}])).resolves.toEqual({ notePaths: ['Docs/01 - guide/01 - Guide.md'] });
		expect(fake.files.has('Docs/guide/Guide.md')).toBe(false);
		expect(fake.files.get('Docs/01 - guide/01 - Guide.md')?.text).toBe('# Updated');
		expect(fake.folders.has('Docs/guide')).toBe(false);
		expect(fake.folders.has('Docs')).toBe(true);
	});

	test('does not overwrite an unrelated note when a collection first claims a path', async () => {
		const fake = createFakeApp();
		await fake.vault.create('Docs/Guide.md', '# User note');
		const writer = new ObsidianVaultWriter(fake.app, settings);

		const first = await writer.commitDocumentCollectionBatch([{
			pageId: 'guide',
			path: 'Docs/Guide.md',
			content: '# Generated v1',
			contentHash: '12345678',
		}]);
		expect(first.notePaths).toEqual(['Docs/Guide-1.md']);
		expect(fake.files.get('Docs/Guide.md')?.text).toBe('# User note');

		await writer.commitDocumentCollectionBatch([{
			pageId: 'guide',
			path: 'Docs/Guide.md',
			ownedPath: 'Docs/Guide-1.md',
			content: '# Generated v2',
			contentHash: 'abcdef12',
		}]);
		expect(fake.files.get('Docs/Guide-1.md')?.text).toBe('# Generated v2');
	});

	test('reserves unique paths across every note in the same collection batch', async () => {
		const fake = createFakeApp();
		await fake.vault.create('Docs/Guide.md', '# Existing');
		const writer = new ObsidianVaultWriter(fake.app, settings);
		await expect(writer.commitDocumentCollectionBatch([
			{ pageId: 'a', path: 'Docs/Guide.md', content: 'A', contentHash: '12345678' },
			{ pageId: 'b', path: 'Docs/Guide-1.md', content: 'B', contentHash: 'abcdef12' },
		])).resolves.toEqual({ notePaths: ['Docs/Guide-1.md', 'Docs/Guide-1-1.md'] });
	});
});
