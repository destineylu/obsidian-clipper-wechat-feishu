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

	const vault = {
		getName: () => 'Test Vault',
		getAbstractFileByPath: vi.fn((path: string): TAbstractFile | null =>
			files.get(path)?.file || null
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
	};
	const fileManager = {
		trashFile: vi.fn(async (file: TFile) => {
			files.delete(file.path);
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
});
