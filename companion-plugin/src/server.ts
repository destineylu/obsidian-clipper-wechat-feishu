import {
	createHash,
	timingSafeEqual,
} from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http';

import {
	DOCUMENT_BUNDLE_CAPABILITY,
	DOCUMENT_BUNDLE_MAX_BYTES,
	DOCUMENT_BUNDLE_MAX_NOTES,
	FEISHU_BRIDGE_PROTOCOL_VERSION,
	FEISHU_BRIDGE_RESUMABLE_CAPABILITY,
	type FeishuBridgeQueueAssetsRequest,
	type DocumentBundleWriteRequest,
} from '../../src/platforms/feishu/bridge-protocol';
import type { DocumentBundleWriter } from './types';
import type { ResumableSessionStore } from './resumable-session-store';
import {
	BridgeProtocolError,
	TransactionStore,
} from './transaction-store';

interface BridgeHttpServerOptions {
	port: number;
	pairingTokenHash: string;
	vaultName: string;
	store: TransactionStore;
	documentBundleWriter?: DocumentBundleWriter;
	resumable?: {
		store: Pick<
			ResumableSessionStore,
			'create' | 'getStatus' | 'queueAssets' |
			'retryCommit' | 'abort' | 'dispose'
		>;
		limits: {
			imageBytes: number;
			fileBytes: number;
			sessionBytes: number;
		};
	};
}

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;
// JSON escaping can nearly double Markdown containing many backslashes/newlines.
// The decoded content limit remains DOCUMENT_BUNDLE_MAX_BYTES below.
const MAX_DOCUMENT_BUNDLE_BODY_BYTES = DOCUMENT_BUNDLE_MAX_BYTES * 2 + 1024 * 1024;

function isSafeNotePath(path: string): boolean {
	const normalized = path.replace(/\\/g, '/').trim();
	const segments = normalized.split('/');
	return Boolean(normalized) &&
		!normalized.startsWith('/') &&
		!/^[a-zA-Z]:/.test(normalized) &&
		segments.every(segment => Boolean(segment) && segment !== '.' && segment !== '..') &&
		!/[\u0000-\u001f|#\[\]]/.test(normalized);
}

function validateDocumentBundleRequest(body: unknown): DocumentBundleWriteRequest {
	if (!body || typeof body !== 'object') {
		throw new BridgeProtocolError('invalid_document_bundle', 400, '文档包请求无效');
	}
	const request = body as Partial<DocumentBundleWriteRequest>;
	if (request.behavior !== 'overwrite' || !Array.isArray(request.notes)) {
		throw new BridgeProtocolError('invalid_document_bundle', 400, '文档包请求无效');
	}
	if (request.notes.length < 1 || request.notes.length > DOCUMENT_BUNDLE_MAX_NOTES) {
		throw new BridgeProtocolError('invalid_document_count', 400, '文档包笔记数量无效');
	}
	const paths = new Set<string>();
	let totalBytes = 0;
	for (const note of request.notes) {
		if (!note || typeof note.path !== 'string' || typeof note.content !== 'string' || !isSafeNotePath(note.path)) {
			throw new BridgeProtocolError('invalid_document_note', 400, '文档包包含无效笔记');
		}
		if (note.sourceUrl !== undefined && (typeof note.sourceUrl !== 'string' || note.sourceUrl.length > 8192)) {
			throw new BridgeProtocolError('invalid_document_source', 400, '文档来源地址无效');
		}
		const pathKey = note.path.replace(/\\/g, '/').toLowerCase();
		if (paths.has(pathKey)) {
			throw new BridgeProtocolError('duplicate_document_path', 400, '文档包包含重复笔记路径');
		}
		paths.add(pathKey);
		totalBytes += Buffer.byteLength(note.content, 'utf8');
		if (totalBytes > DOCUMENT_BUNDLE_MAX_BYTES) {
			throw new BridgeProtocolError('document_bundle_too_large', 413, '文档包内容超过限制');
		}
	}
	return request as DocumentBundleWriteRequest;
}

export function hashPairingToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function headerValue(
	request: IncomingMessage,
	name: string
): string | undefined {
	const value = request.headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

async function readJson<T>(
	request: IncomingMessage,
	maxBytes = MAX_JSON_BODY_BYTES
): Promise<T> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const value of request) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		bytes += chunk.byteLength;
		if (bytes > maxBytes) {
			throw new BridgeProtocolError(
				'request_too_large',
				413,
				'请求内容超过限制'
			);
		}
		chunks.push(chunk);
	}

	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
	} catch {
		throw new BridgeProtocolError('invalid_json', 400, '请求 JSON 无效');
	}
}

function applyResponseHeaders(response: ServerResponse): void {
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader(
		'Access-Control-Allow-Headers',
		'Authorization, Content-Type, X-Asset-Filename, X-Asset-Size'
	);
	response.setHeader(
		'Access-Control-Allow-Methods',
		'GET, POST, PUT, DELETE, OPTIONS'
	);
	response.setHeader('Cache-Control', 'no-store');
	response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	applyResponseHeaders(response);
	response.statusCode = status;
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.end(JSON.stringify(body));
}

function sendError(
	response: ServerResponse,
	error: BridgeProtocolError
): void {
	sendJson(response, error.status, {
		error: {
			code: error.code,
			message: error.message,
		},
	});
}

function isLoopbackAddress(address: string | undefined): boolean {
	return (
		address === '127.0.0.1' ||
		address === '::1' ||
		address === '::ffff:127.0.0.1'
	);
}

export class BridgeHttpServer {
	private server: Server | null = null;
	private activePort = 0;

	constructor(private readonly options: BridgeHttpServerOptions) {}

	async start(): Promise<number> {
		if (this.server) return this.activePort;

		const server = createServer((request, response) => {
			void this.handleRequest(request, response);
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off('listening', onListening);
				reject(error);
			};
			const onListening = () => {
				server.off('error', onError);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(this.options.port, '127.0.0.1');
		});

		const address = server.address();
		if (!address || typeof address === 'string') {
			server.close();
			throw new Error('无法确定配套插件监听端口');
		}
		this.server = server;
		this.activePort = address.port;
		return this.activePort;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		this.activePort = 0;
		await Promise.all([
			this.options.store.dispose(),
			this.options.resumable?.store.dispose(),
		]);
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close(error => error ? reject(error) : resolve());
		});
	}

	private async handleRequest(
		request: IncomingMessage,
		response: ServerResponse
	): Promise<void> {
		try {
			if (!isLoopbackAddress(request.socket.remoteAddress)) {
				throw new BridgeProtocolError('forbidden_client', 403, '仅允许本机访问');
			}

			const host = headerValue(request, 'host');
			if (
				host !== `127.0.0.1:${this.activePort}` &&
				host !== `localhost:${this.activePort}`
			) {
				throw new BridgeProtocolError('invalid_host', 403, '请求主机无效');
			}

			if (request.method === 'OPTIONS') {
				applyResponseHeaders(response);
				if (
					headerValue(
						request,
						'access-control-request-private-network'
					) === 'true'
				) {
					response.setHeader(
						'Access-Control-Allow-Private-Network',
						'true'
					);
				}
				response.statusCode = 204;
				response.end();
				return;
			}

			if (!this.isAuthorized(request)) {
				throw new BridgeProtocolError('unauthorized', 401, '配对令牌无效');
			}

			const url = new URL(
				request.url || '/',
				`http://127.0.0.1:${this.activePort}`
			);

			if (request.method === 'GET' && url.pathname === '/v1/health') {
				const capabilities = [
					...(this.options.resumable ? [FEISHU_BRIDGE_RESUMABLE_CAPABILITY] : []),
					...(this.options.documentBundleWriter ? [DOCUMENT_BUNDLE_CAPABILITY] : []),
				];
				sendJson(response, 200, {
					service: 'clipper-attachment-bridge',
					protocolVersion: FEISHU_BRIDGE_PROTOCOL_VERSION,
					ready: true,
					vaultName: this.options.vaultName,
					...(capabilities.length ? { capabilities } : {}),
					...(this.options.resumable
						? {
							limits: this.options.resumable.limits,
						}
						: {}),
				});
				return;
			}

			if (
				request.method === 'POST' &&
				url.pathname === '/v1/document-bundles' &&
				this.options.documentBundleWriter
			) {
				const body = await readJson<unknown>(request, MAX_DOCUMENT_BUNDLE_BODY_BYTES);
				const validated = validateDocumentBundleRequest(body);
				const result = await this.options.documentBundleWriter.commitDocumentBundle(validated);
				sendJson(response, 200, result);
				return;
			}

			if (
				request.method === 'POST' &&
				url.pathname === '/v1/sessions' &&
				this.options.resumable
			) {
				const body = await readJson<
					Parameters<ResumableSessionStore['create']>[0]
				>(request);
				const result = await this.options.resumable.store.create(body);
				sendJson(response, result.resumed ? 200 : 201, result);
				return;
			}

			const sessionQueueMatch = url.pathname.match(
				/^\/v1\/sessions\/([^/]+)\/queue$/
			);
			if (
				request.method === 'POST' &&
				sessionQueueMatch &&
				this.options.resumable
			) {
				const body = await readJson<FeishuBridgeQueueAssetsRequest>(request);
				const result = await this.options.resumable.store.queueAssets(
					decodeURIComponent(sessionQueueMatch[1]),
					body
				);
				sendJson(response, 202, result);
				return;
			}

			const sessionCommitMatch = url.pathname.match(
				/^\/v1\/sessions\/([^/]+)\/commit$/
			);
			if (
				request.method === 'POST' &&
				sessionCommitMatch &&
				this.options.resumable
			) {
				const result = await this.options.resumable.store.retryCommit(
					decodeURIComponent(sessionCommitMatch[1])
				);
				sendJson(response, 200, result);
				return;
			}

			const sessionMatch = url.pathname.match(
				/^\/v1\/sessions\/([^/]+)$/
			);
			if (
				request.method === 'GET' &&
				sessionMatch &&
				this.options.resumable
			) {
				sendJson(
					response,
					200,
					this.options.resumable.store.getStatus(
						decodeURIComponent(sessionMatch[1])
					)
				);
				return;
			}
			if (
				request.method === 'DELETE' &&
				sessionMatch &&
				this.options.resumable
			) {
				await this.options.resumable.store.abort(
					decodeURIComponent(sessionMatch[1])
				);
				applyResponseHeaders(response);
				response.statusCode = 204;
				response.end();
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1/transactions') {
				const body = await readJson<
					Parameters<TransactionStore['create']>[0]
				>(request);
				const transaction = await this.options.store.create(body);
				sendJson(response, 201, {
					transactionId: transaction.id,
					expiresAt: transaction.expiresAt.toISOString(),
				});
				return;
			}

			const assetMatch = url.pathname.match(
				/^\/v1\/transactions\/([^/]+)\/assets\/(\d+)$/
			);
			if (request.method === 'PUT' && assetMatch) {
				const filenameHeader = headerValue(request, 'x-asset-filename');
				let filename = '';
				try {
					filename = decodeURIComponent(filenameHeader || '');
				} catch {
					throw new BridgeProtocolError(
						'invalid_asset_filename',
						400,
						'附件文件名无效'
					);
				}
				const sizeHeader = headerValue(request, 'x-asset-size');
				const declaredBytes = sizeHeader === undefined
					? undefined
					: Number(sizeHeader);
				const result = await this.options.store.stageAsset(
					decodeURIComponent(assetMatch[1]),
					Number(assetMatch[2]),
					request,
					{
						filename,
						contentType:
							headerValue(request, 'content-type') ||
							'application/octet-stream',
						declaredBytes,
					}
				);
				sendJson(response, 200, result);
				return;
			}

			const commitMatch = url.pathname.match(
				/^\/v1\/transactions\/([^/]+)\/commit$/
			);
			if (request.method === 'POST' && commitMatch) {
				const body = await readJson<{ content?: unknown }>(request);
				if (typeof body.content !== 'string') {
					throw new BridgeProtocolError(
						'invalid_note_content',
						400,
						'笔记内容无效'
					);
				}
				const result = await this.options.store.commit(
					decodeURIComponent(commitMatch[1]),
					body.content
				);
				sendJson(response, 200, result);
				return;
			}

			const transactionMatch = url.pathname.match(
				/^\/v1\/transactions\/([^/]+)$/
			);
			if (request.method === 'DELETE' && transactionMatch) {
				await this.options.store.abort(
					decodeURIComponent(transactionMatch[1])
				);
				applyResponseHeaders(response);
				response.statusCode = 204;
				response.end();
				return;
			}

			throw new BridgeProtocolError('not_found', 404, '接口不存在');
		} catch (error) {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			if (error instanceof BridgeProtocolError) {
				sendError(response, error);
			} else {
				sendError(
					response,
					new BridgeProtocolError(
						'internal_error',
						500,
						'配套插件内部错误'
					)
				);
			}
		}
	}

	private isAuthorized(request: IncomingMessage): boolean {
		const authorization = headerValue(request, 'authorization');
		if (!authorization?.startsWith('Bearer ')) return false;
		const token = authorization.slice('Bearer '.length);
		const actual = Buffer.from(hashPairingToken(token), 'hex');
		let expected: Buffer;
		try {
			expected = Buffer.from(this.options.pairingTokenHash, 'hex');
		} catch {
			return false;
		}
		return (
			actual.byteLength === expected.byteLength &&
			actual.byteLength > 0 &&
			timingSafeEqual(actual, expected)
		);
	}
}
