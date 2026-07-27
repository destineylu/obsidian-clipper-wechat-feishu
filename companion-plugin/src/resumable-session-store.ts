import { randomUUID } from 'node:crypto';
import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
	replaceFeishuSessionAssetPlaceholder,
	type FeishuBridgeCommitResponse,
	type FeishuBridgeCreateSessionRequest,
	type FeishuBridgeCreateSessionResponse,
	type FeishuBridgeQueueAssetsRequest,
	type FeishuBridgeRemoteAssetRequest,
	type FeishuBridgeSessionAssetStatus,
	type FeishuBridgeSessionStatus,
} from '../../src/platforms/feishu/bridge-protocol';
import type {
	BridgeTransaction,
	BridgeTransactionWriter,
	StagedAsset,
} from './types';
import {
	downloadRemoteMedia,
	RemoteMediaDownloadError,
	type RemoteMediaDownloadOptions,
	type RemoteMediaDownloadResult,
} from './remote-media-downloader';
import { BridgeProtocolError } from './transaction-store';

interface ResumableSessionStoreOptions {
	rootDirectory: string;
	imageMaxBytes: number;
	fileMaxBytes: number;
	sessionMaxBytes: number;
	retentionMs: number;
	downloadConcurrency: number;
}

interface PersistedSessionAsset extends FeishuBridgeSessionAssetStatus {
	alt: string;
	expectedBytes?: number;
	filename?: string;
	contentType?: string;
	sha256?: string;
	tempFilename?: string;
}

interface PersistedSession {
	version: 1;
	id: string;
	resumeKey: string;
	sourceKey?: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
	phase: FeishuBridgeSessionStatus['phase'];
	note: FeishuBridgeCreateSessionRequest['note'];
	sourceOrigin: string;
	assets: PersistedSessionAsset[];
	notePath?: string;
	error?: string;
}

interface RuntimeSession {
	manifest: PersistedSession;
	directory: string;
	queue: Map<number, FeishuBridgeRemoteAssetRequest>;
	controllers: Map<number, AbortController>;
	retryUntil: Map<number, number>;
	running: Promise<void> | null;
	persisting: Promise<void>;
	transferStartedAt: number | null;
	transferStartedBytes: number;
}

type DownloadImplementation = (
	options: RemoteMediaDownloadOptions
) => Promise<RemoteMediaDownloadResult>;

const TRANSIENT_DOWNLOAD_RETRY_DELAYS_MS = [
	1_000,
];
const DOWNLOAD_START_INTERVAL_MS = 250;
const FEISHU_RATE_LIMIT_MINIMUM_DELAY_MS = 5_000;
const ASSET_DOWNLOAD_BUDGET_MS = 3 * 60_000;
const STRINGIFIED_READABLE_STREAM_SHA256 =
	'7559c3628a54a498b715edbbb9a0f16fc65e94eaaf185b41e91f6bddf1a8e02e';

function isFeishuRateLimitError(error: unknown): boolean {
	return error instanceof RemoteMediaDownloadError &&
		String(error.feishuCode) === '99991400';
}

export function isTransientDownloadError(error: unknown): boolean {
	if (error instanceof RemoteMediaDownloadError) {
		if (error.code !== 'remote_download_failed') return false;
		if (isFeishuRateLimitError(error)) return true;
		const status = error.httpStatus ??
			Number(error.message.match(/HTTP\s+(\d{3})/i)?.[1]);
		return (
			status === 408 ||
			status === 425 ||
			status === 429 ||
			(status >= 500 && status <= 599)
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return (
		error instanceof TypeError ||
		/(?:failed to fetch|network|socket|terminated|econn|etimedout|und_err)/i
			.test(message)
	);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = () => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		};
		const timer = setTimeout(finish, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error('附件下载已取消')
			);
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

function cleanError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/https?:\/\/\S+/gi, '[redacted-url]')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.trim()
		.slice(0, 300) || '附件下载失败';
}

function safeFilename(rawFilename: string, index: number): string {
	const filename = rawFilename
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*#\[\]\u0000-\u001f\u007f]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/^\.+|\.+$/g, '')
		.trim()
		.slice(0, 120);
	return filename || `asset-${index}`;
}

function extensionForContentType(contentType: string): string {
	const extensions: Record<string, string> = {
		'image/avif': '.avif',
		'image/bmp': '.bmp',
		'image/gif': '.gif',
		'image/heif': '.heif',
		'image/jpeg': '.jpg',
		'image/png': '.png',
		'image/tiff': '.tiff',
		'image/webp': '.webp',
		'video/mp4': '.mp4',
		'video/quicktime': '.mov',
		'video/webm': '.webm',
		'application/pdf': '.pdf',
		'application/zip': '.zip',
	};
	return extensions[contentType] || '';
}

function ensureFilenameExtension(filename: string, contentType: string): string {
	const extension = extensionForContentType(contentType);
	if (!extension) return filename;
	const current = filename.match(/\.[a-z0-9]{1,10}$/i)?.[0]?.toLowerCase();
	if (!current) return `${filename}${extension}`;
	const compatibleExtensions: Record<string, string[]> = {
		'image/jpeg': ['.jpg', '.jpeg'],
		'image/tiff': ['.tif', '.tiff'],
		'video/quicktime': ['.mov', '.qt'],
	};
	if (
		(compatibleExtensions[contentType] || [extension]).includes(current)
	) {
		return filename;
	}
	const knownMediaExtensions = new Set([
		'.avif', '.bmp', '.gif', '.heic', '.heif', '.jpeg', '.jpg',
		'.mov', '.mp4', '.png', '.qt', '.tif', '.tiff', '.webm', '.webp',
	]);
	return knownMediaExtensions.has(current)
		? `${filename.slice(0, -current.length)}${extension}`
		: filename;
}

export class ResumableSessionStore {
	private readonly sessions = new Map<string, RuntimeSession>();
	private readonly resumeIndex = new Map<string, string>();
	private readonly downloadWaiters: Array<() => void> = [];
	private activeDownloads = 0;
	private nextDownloadStartAt = 0;
	private downloadStartGate: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		private readonly writer: BridgeTransactionWriter,
		private readonly options: ResumableSessionStoreOptions,
		private readonly downloadImpl: DownloadImplementation = downloadRemoteMedia
	) {}

	async initialize(): Promise<void> {
		await mkdir(this.options.rootDirectory, { recursive: true });
		const entries = await readdir(this.options.rootDirectory, {
			withFileTypes: true,
		});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const directory = join(this.options.rootDirectory, entry.name);
			try {
				const manifest = JSON.parse(
					await readFile(join(directory, 'session.json'), 'utf8')
				) as PersistedSession;
				if (!this.isValidManifest(manifest)) throw new Error('invalid manifest');
				if (new Date(manifest.expiresAt).getTime() <= Date.now()) {
					await rm(directory, { recursive: true, force: true });
					continue;
				}
				for (const asset of manifest.assets) {
					// Finalized sessions intentionally remove their staging files
					// after the Vault commit. Do not turn them back into pending
					// assets when the plugin reloads.
					if (manifest.phase === 'completed') continue;
					if (asset.state === 'downloading') asset.state = 'pending';
					if (asset.state === 'completed' && asset.tempFilename) {
						await stat(join(directory, asset.tempFilename)).then(info => {
							if (info.size <= 0 || asset.byteLength <= 0) {
								throw new Error('empty completed asset');
							}
						}).catch(() => {
							asset.state = 'pending';
							asset.byteLength = 0;
							delete asset.vaultPath;
							delete asset.tempFilename;
						});
					}
				}
				if (manifest.phase !== 'completed') {
					manifest.phase = manifest.assets.every(
						asset => asset.state === 'completed'
					) ? 'ready' : 'waiting';
				}
				const runtime = this.runtimeSession(manifest, directory);
				this.sessions.set(manifest.id, runtime);
				this.resumeIndex.set(manifest.resumeKey, manifest.id);
				this.restoreReservations(runtime);
				await this.persist(runtime);
			} catch {
				await rm(directory, { recursive: true, force: true });
			}
		}
	}

	async create(
		request: FeishuBridgeCreateSessionRequest
	): Promise<FeishuBridgeCreateSessionResponse> {
		this.validateCreateRequest(request);
		const existingId = this.resumeIndex.get(request.resumeKey);
		let exactExisting = existingId
			? this.sessions.get(existingId)
			: undefined;
		if (
			exactExisting &&
			this.completedSessionNeedsRedownload(exactExisting)
		) {
			// Preserve the old note and assets, but stop returning a falsely
			// completed session. The next click creates a clean, independently
			// resumable download without overwriting user data.
			if (this.resumeIndex.get(request.resumeKey) === exactExisting.manifest.id) {
				this.resumeIndex.delete(request.resumeKey);
			}
			exactExisting = undefined;
		}
		const existing = exactExisting || this.findCompatibleSession(request);
		if (existing) {
			const previousResumeKey = existing.manifest.resumeKey;
			if (
				previousResumeKey !== request.resumeKey &&
				this.resumeIndex.get(previousResumeKey) === existing.manifest.id
			) {
				this.resumeIndex.delete(previousResumeKey);
			}
			existing.manifest.resumeKey = request.resumeKey;
			existing.manifest.sourceKey = request.sourceKey;
			existing.manifest.note = request.note;
			existing.manifest.assets.forEach((asset, index) => {
				asset.alt = request.assets[index].alt;
			});
			this.resumeIndex.set(request.resumeKey, existing.manifest.id);
			this.touch(existing);
			await this.persist(existing);
			return {
				sessionId: existing.manifest.id,
				resumed: true,
				status: this.status(existing),
			};
		}

		const id = randomUUID();
		const now = new Date();
		const directory = join(this.options.rootDirectory, id);
		await mkdir(directory, { recursive: false });
		const manifest: PersistedSession = {
			version: 1,
			id,
			resumeKey: request.resumeKey,
			sourceKey: request.sourceKey,
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
			expiresAt: new Date(
				now.getTime() + this.options.retentionMs
			).toISOString(),
			phase: 'waiting',
			note: request.note,
			sourceOrigin: request.sourceOrigin,
			assets: request.assets.map(asset => ({
				index: asset.index,
				kind: asset.kind,
				alt: asset.alt,
				state: 'pending',
				byteLength: 0,
			})),
		};
		const runtime = this.runtimeSession(manifest, directory);
		this.sessions.set(id, runtime);
		this.resumeIndex.set(request.resumeKey, id);
		await this.persist(runtime);
		return {
			sessionId: id,
			resumed: false,
			status: this.status(runtime),
		};
	}

	getStatus(sessionId: string): FeishuBridgeSessionStatus {
		return this.status(this.getActive(sessionId));
	}

	async queueAssets(
		sessionId: string,
		request: FeishuBridgeQueueAssetsRequest
	): Promise<FeishuBridgeSessionStatus> {
		const session = this.getActive(sessionId);
		if (!Array.isArray(request.assets) || !request.assets.length) {
			throw new BridgeProtocolError('invalid_asset_queue', 400, '附件队列为空');
		}
		for (const descriptor of request.assets) {
			const asset = session.manifest.assets[descriptor.index];
			if (
				!asset ||
				descriptor.kind !== asset.kind ||
				typeof descriptor.downloadUrl !== 'string' ||
				descriptor.downloadUrl.length < 1 ||
				(
					descriptor.fallbackDownloadUrls !== undefined &&
					(
						!Array.isArray(descriptor.fallbackDownloadUrls) ||
						descriptor.fallbackDownloadUrls.length > 5 ||
						descriptor.fallbackDownloadUrls.some(
							url => typeof url !== 'string' || url.length < 1
						)
					)
				) ||
				(
					descriptor.bearerToken !== undefined &&
					!/^[-._~+/=A-Za-z0-9]{1,4096}$/.test(
						descriptor.bearerToken
					)
				)
			) {
				throw new BridgeProtocolError(
					'invalid_asset_queue',
					400,
					'附件队列参数无效'
				);
			}
			if (asset.state === 'completed') continue;
			asset.state = 'pending';
			asset.error = undefined;
			if (
				typeof descriptor.expectedBytes === 'number' &&
				Number.isFinite(descriptor.expectedBytes) &&
				descriptor.expectedBytes > 0
			) {
				asset.expectedBytes = descriptor.expectedBytes;
			}
			session.queue.set(descriptor.index, descriptor);
		}
		if (!session.running) {
			session.transferStartedAt = Date.now();
			session.transferStartedBytes = session.manifest.assets
				.filter(asset => asset.state === 'completed')
				.reduce((sum, asset) => sum + asset.byteLength, 0);
		}
		session.manifest.phase = 'downloading';
		this.touch(session);
		await this.persist(session);
		if (!session.running) {
			session.running = this.runQueue(session).finally(() => {
				session.running = null;
			});
		}
		return this.status(session);
	}

	async waitForIdle(sessionId: string): Promise<void> {
		const session = this.getActive(sessionId);
		await session.running;
	}

	async retryCommit(sessionId: string): Promise<FeishuBridgeSessionStatus> {
		const session = this.getActive(sessionId);
		if (!session.manifest.assets.every(asset => asset.state === 'completed')) {
			throw new BridgeProtocolError(
				'assets_incomplete',
				409,
				'附件尚未全部完成'
			);
		}
		await this.commit(session);
		return this.status(session);
	}

	async abort(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		for (const controller of session.controllers.values()) controller.abort();
		await session.running?.catch(() => undefined);
		this.writer.release(sessionId);
		this.sessions.delete(sessionId);
		this.resumeIndex.delete(session.manifest.resumeKey);
		await rm(session.directory, { recursive: true, force: true });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			for (const controller of session.controllers.values()) controller.abort();
		}
		await Promise.all(
			[...this.sessions.values()].map(session =>
				session.running?.catch(() => undefined)
			)
		);
	}

	private async runQueue(session: RuntimeSession): Promise<void> {
		const workers = Array.from(
			{ length: Math.max(1, this.options.downloadConcurrency) },
			() => this.runWorker(session)
		);
		await Promise.all(workers);
		if (
			!this.disposed &&
			session.manifest.assets.every(asset => asset.state === 'completed')
		) {
			await this.commit(session);
		} else if (!this.disposed) {
			session.manifest.phase = session.manifest.assets.some(
				asset => asset.state === 'failed'
			) ? 'failed' : 'waiting';
			this.touch(session);
			await this.persist(session);
		}
	}

	private async runWorker(session: RuntimeSession): Promise<void> {
		while (!this.disposed) {
			const next = session.queue.entries().next().value as
				| [number, FeishuBridgeRemoteAssetRequest]
				| undefined;
			if (!next) return;
			const [index, descriptor] = next;
			session.queue.delete(index);
			const asset = session.manifest.assets[index];
			if (!asset || asset.state === 'completed') continue;
			const controller = new AbortController();
			session.controllers.set(index, controller);
			asset.state = 'downloading';
			asset.error = undefined;
			this.touch(session);
			await this.persist(session);

			const tempFilename = `${index}.part`;
			const tempPath = join(session.directory, tempFilename);
			const maxBytes = asset.kind === 'image'
				? this.options.imageMaxBytes
				: this.options.fileMaxBytes;
			try {
				const releaseDownloadSlot = await this.acquireDownloadSlot(
					controller.signal
				);
				let result: RemoteMediaDownloadResult | undefined;
				try {
					const candidateUrls = [
						descriptor.downloadUrl,
						...(descriptor.fallbackDownloadUrls || []),
					];
					const downloadDeadline =
						Date.now() + ASSET_DOWNLOAD_BUDGET_MS;
					let lastError: unknown;
					downloadCandidates:
					for (const url of candidateUrls) {
						for (
							let attempt = 0;
							attempt <= TRANSIENT_DOWNLOAD_RETRY_DELAYS_MS.length;
							attempt += 1
						) {
							if (Date.now() >= downloadDeadline) {
								lastError = new RemoteMediaDownloadError(
									'remote_download_timeout',
									'单个飞书媒体下载超过 3 分钟，已停止重试'
								);
								break downloadCandidates;
							}
							try {
								await this.waitForDownloadStart(
									controller.signal
								);
								result = await this.downloadImpl({
									url,
									destination: tempPath,
									maxBytes,
									bearerToken: descriptor.bearerToken,
									signal: controller.signal,
									onProgress: (bytes, totalBytes) => {
										asset.byteLength = bytes;
										if (
											typeof totalBytes === 'number' &&
											Number.isFinite(totalBytes) &&
											totalBytes > 0
										) {
											asset.expectedBytes = totalBytes;
										}
										this.touch(session);
									},
								});
								break;
							} catch (error) {
								lastError = error;
								asset.byteLength = 0;
								if (controller.signal.aborted) throw error;
								if (Date.now() >= downloadDeadline) {
									lastError = new RemoteMediaDownloadError(
										'remote_download_timeout',
										'单个飞书媒体下载超过 3 分钟，已停止重试'
									);
									break downloadCandidates;
								}
								if (
									attempt >= TRANSIENT_DOWNLOAD_RETRY_DELAYS_MS.length ||
									!isTransientDownloadError(error)
								) {
									break;
								}
								const rateLimited = isFeishuRateLimitError(error);
								const retryDelay = rateLimited
									? Math.max(
										error instanceof RemoteMediaDownloadError
											? error.retryAfterMs || 0
											: 0,
										FEISHU_RATE_LIMIT_MINIMUM_DELAY_MS,
										TRANSIENT_DOWNLOAD_RETRY_DELAYS_MS[attempt]
									)
									: TRANSIENT_DOWNLOAD_RETRY_DELAYS_MS[attempt];
								if (rateLimited) {
									this.postponeDownloadStarts(retryDelay);
								}
								const boundedRetryDelay = Math.min(
									retryDelay,
									Math.max(0, downloadDeadline - Date.now())
								);
								if (boundedRetryDelay <= 0) {
									lastError = new RemoteMediaDownloadError(
										'remote_download_timeout',
										'单个飞书媒体下载超过 3 分钟，已停止重试'
									);
									break downloadCandidates;
								}
								session.retryUntil.set(
									index,
									Date.now() + boundedRetryDelay
								);
								this.touch(session);
								await this.persist(session);
								try {
									await waitForRetry(
										boundedRetryDelay,
										controller.signal
									);
								} finally {
									session.retryUntil.delete(index);
								}
							}
						}
						if (result) break;
					}
					if (!result) {
						throw lastError instanceof Error
							? lastError
							: new Error('飞书媒体下载失败');
					}
				} finally {
					releaseDownloadSlot();
				}
				const completedBytes = session.manifest.assets
					.filter(item => item.state === 'completed')
					.reduce((sum, item) => sum + item.byteLength, 0);
				if (completedBytes + result.byteLength > this.options.sessionMaxBytes) {
					await rm(tempPath, { force: true });
					throw new BridgeProtocolError(
						'session_too_large',
						413,
						'本次保存的附件总量超过会话限制'
					);
				}
				const filename = ensureFilenameExtension(
					safeFilename(
						result.suggestedFilename || descriptor.filename,
						index
					),
					result.contentType
				);
				const vaultPath = this.writer.reserveAssetPath(
					session.manifest.id,
					index,
					filename,
					session.manifest.note.path
				);
				Object.assign(asset, {
					state: 'completed' as const,
					byteLength: result.byteLength,
					filename,
					contentType: result.contentType,
					sha256: result.sha256,
					tempFilename,
					vaultPath,
					error: undefined,
				});
			} catch (error) {
				asset.state = 'failed';
				asset.byteLength = 0;
				asset.error = cleanError(error);
				await rm(tempPath, { force: true }).catch(() => undefined);
			} finally {
				session.retryUntil.delete(index);
				session.controllers.delete(index);
				this.touch(session);
				await this.persist(session);
			}
		}
	}

	private async commit(session: RuntimeSession): Promise<void> {
		if (session.manifest.phase === 'completed') return;
		session.manifest.phase = 'committing';
		session.manifest.error = undefined;
		this.touch(session);
		await this.persist(session);

		let content = session.manifest.note.content;
		const stagedAssets = new Map<number, StagedAsset>();
		for (const asset of session.manifest.assets) {
			if (
				asset.state !== 'completed' ||
				!asset.tempFilename ||
				!asset.vaultPath ||
				!asset.filename ||
				!asset.contentType
			) {
				throw new BridgeProtocolError(
					'assets_incomplete',
					409,
					'附件尚未全部完成'
				);
			}
			content = replaceFeishuSessionAssetPlaceholder(
				content,
				asset.index,
				asset.vaultPath,
				asset.kind,
				asset.alt
			);
			stagedAssets.set(asset.index, {
				index: asset.index,
				vaultPath: asset.vaultPath,
				byteLength: asset.byteLength,
				tempPath: join(session.directory, asset.tempFilename),
				filename: asset.filename,
				contentType: asset.contentType,
			});
		}

		const transaction: BridgeTransaction = {
			id: session.manifest.id,
			expiresAt: new Date(session.manifest.expiresAt),
			request: {
				note: {
					path: session.manifest.note.path,
					behavior: session.manifest.note.behavior,
					content: '',
				},
				sourceUrl: session.manifest.sourceOrigin,
				assetCount: stagedAssets.size,
			},
			tempDirectory: session.directory,
			assets: stagedAssets,
			totalBytes: [...stagedAssets.values()].reduce(
				(sum, asset) => sum + asset.byteLength,
				0
			),
			reservedBytes: 0,
			activeAssetIndexes: new Set(),
		};

		try {
			const result: FeishuBridgeCommitResponse =
				await this.writer.commit(transaction, content);
			session.manifest.phase = 'completed';
			session.manifest.notePath = result.notePath;
			this.touch(session);
			await this.persist(session);
			await Promise.all(
				session.manifest.assets.map(asset =>
					asset.tempFilename
						? rm(join(session.directory, asset.tempFilename), {
							force: true,
						})
						: Promise.resolve()
				)
			);
			this.writer.release(session.manifest.id);
		} catch (error) {
			session.manifest.phase = 'failed';
			session.manifest.error = cleanError(error);
			this.touch(session);
			await this.persist(session);
			throw error;
		}
	}

	private restoreReservations(session: RuntimeSession): void {
		if (session.manifest.phase === 'completed') return;
		for (const asset of session.manifest.assets) {
			if (
				asset.state !== 'completed' ||
				!asset.filename
			) {
				continue;
			}
			asset.vaultPath = this.writer.reserveAssetPath(
				session.manifest.id,
				asset.index,
				asset.filename,
				session.manifest.note.path
			);
		}
	}

	private runtimeSession(
		manifest: PersistedSession,
		directory: string
	): RuntimeSession {
		return {
			manifest,
			directory,
			queue: new Map(),
			controllers: new Map(),
			retryUntil: new Map(),
			running: null,
			persisting: Promise.resolve(),
			transferStartedAt: null,
			transferStartedBytes: manifest.assets
				.filter(asset => asset.state === 'completed')
				.reduce((sum, asset) => sum + asset.byteLength, 0),
		};
	}

	private findCompatibleSession(
		request: FeishuBridgeCreateSessionRequest
	): RuntimeSession | undefined {
		const candidates = [...this.sessions.values()].filter(session => {
			const manifest = session.manifest;
			if (manifest.phase === 'completed') return false;
			if (
				manifest.sourceKey &&
				request.sourceKey &&
				manifest.sourceKey !== request.sourceKey
			) {
				return false;
			}
			if (
				manifest.sourceOrigin !== request.sourceOrigin ||
				manifest.note.path !== request.note.path ||
				manifest.note.behavior !== request.note.behavior ||
				manifest.assets.length !== request.assets.length
			) {
				return false;
			}
			return manifest.assets.every(
				(asset, index) => asset.kind === request.assets[index].kind
			);
		});
		return candidates.sort((left, right) => {
			const completed = (session: RuntimeSession) =>
				session.manifest.assets.filter(
					asset => asset.state === 'completed'
				).length;
			return (
				completed(right) - completed(left) ||
				Date.parse(left.manifest.createdAt) -
					Date.parse(right.manifest.createdAt)
			);
		})[0];
	}

	private completedSessionNeedsRedownload(
		session: RuntimeSession
	): boolean {
		if (session.manifest.phase !== 'completed') return false;
		return session.manifest.assets.some(
			asset => asset.sha256 === STRINGIFIED_READABLE_STREAM_SHA256
		);
	}

	private async waitForDownloadStart(signal: AbortSignal): Promise<void> {
		let releaseGate: () => void = () => {};
		const precedingStart = this.downloadStartGate;
		this.downloadStartGate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		await precedingStart;
		try {
			const delay = Math.max(0, this.nextDownloadStartAt - Date.now());
			if (delay > 0) await waitForRetry(delay, signal);
			this.nextDownloadStartAt = Date.now() + DOWNLOAD_START_INTERVAL_MS;
		} finally {
			releaseGate();
		}
	}

	private postponeDownloadStarts(delayMs: number): void {
		this.nextDownloadStartAt = Math.max(
			this.nextDownloadStartAt,
			Date.now() + delayMs
		);
	}

	private acquireDownloadSlot(
		signal: AbortSignal
	): Promise<() => void> {
		if (signal.aborted) {
			return Promise.reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error('附件下载已取消')
			);
		}
		if (this.activeDownloads < this.options.downloadConcurrency) {
			this.activeDownloads += 1;
			return Promise.resolve(() => this.releaseDownloadSlot());
		}

		return new Promise((resolve, reject) => {
			const wake = () => {
				signal.removeEventListener('abort', onAbort);
				this.activeDownloads += 1;
				resolve(() => this.releaseDownloadSlot());
			};
			const onAbort = () => {
				const index = this.downloadWaiters.indexOf(wake);
				if (index >= 0) this.downloadWaiters.splice(index, 1);
				reject(
					signal.reason instanceof Error
						? signal.reason
						: new Error('附件下载已取消')
				);
			};
			this.downloadWaiters.push(wake);
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private releaseDownloadSlot(): void {
		this.activeDownloads = Math.max(0, this.activeDownloads - 1);
		const next = this.downloadWaiters.shift();
		next?.();
	}

	private status(session: RuntimeSession): FeishuBridgeSessionStatus {
		const needsRedownload = this.completedSessionNeedsRedownload(session);
		const now = Date.now();
		const assets = session.manifest.assets.map(asset => ({
			index: asset.index,
			kind: asset.kind,
			state: asset.state,
			byteLength: asset.byteLength,
			...(asset.vaultPath ? { vaultPath: asset.vaultPath } : {}),
			...(asset.error ? { error: asset.error } : {}),
		}));
		const expectedBytes = session.manifest.assets.reduce(
			(sum, asset) => sum + (
				asset.expectedBytes ||
				(asset.state === 'completed' ? asset.byteLength : 0)
			),
			0
		);
		const phase = needsRedownload
			? 'failed' as const
			: session.manifest.phase;
		const knownCorruptAssets = needsRedownload
			? session.manifest.assets.filter(
				asset => asset.sha256 === STRINGIFIED_READABLE_STREAM_SHA256
			).length
			: 0;
		const downloadedBytes = assets.reduce(
			(sum, asset) => sum + asset.byteLength,
			0
		);
		const retryDeadlines = [...session.retryUntil.values()]
			.filter(deadline => deadline > now);
		const activeAssets = assets.filter(
			asset => asset.state === 'downloading'
		).length;
		const elapsedSeconds = session.transferStartedAt === null
			? 0
			: Math.max(0, (now - session.transferStartedAt) / 1_000);
		const transferredBytes = Math.max(
			0,
			downloadedBytes - session.transferStartedBytes
		);
		const bytesPerSecond = elapsedSeconds > 0 && transferredBytes > 0
			? transferredBytes / elapsedSeconds
			: undefined;
		return {
			sessionId: session.manifest.id,
			phase,
			assetCount: assets.length,
			completedAssets: assets.filter(
				asset => asset.state === 'completed'
			).length,
			failedAssets: Math.max(
				assets.filter(asset => asset.state === 'failed').length,
				knownCorruptAssets
			),
			downloadedBytes,
			...(expectedBytes > 0 ? { totalBytes: expectedBytes } : {}),
			isTotalBytesFinal: assets.every(
				asset => asset.state === 'completed'
			),
			activeAssets,
			retryingAssets: retryDeadlines.length,
			...(retryDeadlines.length
				? {
					retryAfterMs: Math.max(
						0,
						Math.min(...retryDeadlines) - now
					),
				}
				: {}),
			...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
			assets,
			...(session.manifest.notePath
				? { notePath: session.manifest.notePath }
				: {}),
			...(needsRedownload || session.manifest.error
				? {
					error: needsRedownload
						? '检测到旧版本写入的损坏媒体，请再次点击“添加到 Obsidian”重新下载'
						: session.manifest.error,
				}
				: {}),
			updatedAt: session.manifest.updatedAt,
		};
	}

	private validateCreateRequest(request: FeishuBridgeCreateSessionRequest): void {
		if (
			!request ||
			!/^[a-f0-9]{64}$/i.test(request.resumeKey) ||
			(
				request.sourceKey !== undefined &&
				!/^[a-f0-9]{64}$/i.test(request.sourceKey)
			) ||
			typeof request.note?.path !== 'string' ||
			typeof request.note?.content !== 'string' ||
			request.note.content.includes('feishu-bridge://') ||
			typeof request.sourceOrigin !== 'string' ||
			!Array.isArray(request.assets) ||
			request.assets.length < 1 ||
			request.assets.length > 1000 ||
			request.assets.some((asset, index) =>
				asset.index !== index ||
				!['image', 'video', 'file'].includes(asset.kind) ||
				typeof asset.alt !== 'string'
			)
		) {
			throw new BridgeProtocolError(
				'invalid_session',
				400,
				'可恢复保存会话参数无效'
			);
		}
	}

	private getActive(sessionId: string): RuntimeSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new BridgeProtocolError('session_not_found', 404, '保存会话不存在');
		}
		if (
			session.manifest.phase !== 'completed' &&
			new Date(session.manifest.expiresAt).getTime() <= Date.now()
		) {
			throw new BridgeProtocolError('session_expired', 410, '保存会话已过期');
		}
		return session;
	}

	private touch(session: RuntimeSession): void {
		const now = new Date();
		session.manifest.updatedAt = now.toISOString();
		session.manifest.expiresAt = new Date(
			now.getTime() + this.options.retentionMs
		).toISOString();
	}

	private persist(session: RuntimeSession): Promise<void> {
		session.persisting = session.persisting.then(async () => {
			const tempPath = join(
				session.directory,
				`session-${randomUUID()}.tmp`
			);
			await writeFile(
				tempPath,
				JSON.stringify(session.manifest, null, 2),
				{ encoding: 'utf8', mode: 0o600 }
			);
			await rename(tempPath, join(session.directory, 'session.json'));
		});
		return session.persisting;
	}

	private isValidManifest(value: PersistedSession): boolean {
		return (
			value?.version === 1 &&
			typeof value.id === 'string' &&
			/^[a-f0-9]{64}$/i.test(value.resumeKey) &&
			(
				value.sourceKey === undefined ||
				/^[a-f0-9]{64}$/i.test(value.sourceKey)
			) &&
			typeof value.note?.content === 'string' &&
			!value.note.content.includes('feishu-bridge://') &&
			Array.isArray(value.assets)
		);
	}
}
