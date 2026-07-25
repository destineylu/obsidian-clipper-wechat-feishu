import {
	FEISHU_BRIDGE_PROTOCOL_VERSION,
	normalizeFeishuBridgeEndpoint,
	type FeishuBridgeCommitResponse,
	type FeishuBridgeCreateSessionRequest,
	type FeishuBridgeCreateSessionResponse,
	type FeishuBridgeCreateTransactionRequest,
	type FeishuBridgeCreateTransactionResponse,
	type FeishuBridgeErrorResponse,
	type FeishuBridgeHealthResponse,
	type FeishuBridgeQueueAssetsRequest,
	type FeishuBridgeSessionStatus,
	type FeishuBridgeUploadAssetResponse,
} from './bridge-protocol';

type FetchImplementation = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response>;

interface FeishuBridgeClientOptions {
	endpoint: string;
	pairingToken: string;
	fetchImpl?: FetchImplementation;
	requestTimeoutMs?: number;
}

export interface FeishuBridgeUploadOptions {
	body: BodyInit;
	filename: string;
	contentType: string;
	byteLength?: number;
	signal?: AbortSignal;
}

type StreamingRequestInit = RequestInit & {
	duplex?: 'half';
};

export class FeishuBridgeRequestError extends Error {
	constructor(
		public readonly code: string,
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'FeishuBridgeRequestError';
	}
}

function cleanServerMessage(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
	return cleaned || fallback;
}

export class FeishuBridgeClient {
	private readonly endpoint: string;
	private readonly pairingToken: string;
	private readonly fetchImpl: FetchImplementation;
	private readonly requestTimeoutMs: number;

	constructor(options: FeishuBridgeClientOptions) {
		this.endpoint = normalizeFeishuBridgeEndpoint(options.endpoint);
		this.pairingToken = options.pairingToken.trim();
		if (!this.pairingToken) {
			throw new Error('配对令牌不能为空');
		}
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
		this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
	}

	async health(signal?: AbortSignal): Promise<FeishuBridgeHealthResponse> {
		const result = await this.requestJson<FeishuBridgeHealthResponse>(
			'/v1/health',
			{ method: 'GET', signal },
			5_000
		);

		if (
			result.service !== 'clipper-attachment-bridge' ||
			result.protocolVersion !== FEISHU_BRIDGE_PROTOCOL_VERSION
		) {
			throw new FeishuBridgeRequestError(
				'incompatible_protocol',
				200,
				'配套插件协议版本不兼容'
			);
		}
		return result;
	}

	createTransaction(
		request: FeishuBridgeCreateTransactionRequest,
		signal?: AbortSignal
	): Promise<FeishuBridgeCreateTransactionResponse> {
		return this.requestJson('/v1/transactions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
			signal,
		});
	}

	createSession(
		request: FeishuBridgeCreateSessionRequest,
		signal?: AbortSignal
	): Promise<FeishuBridgeCreateSessionResponse> {
		return this.requestJson('/v1/sessions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
			signal,
		});
	}

	getSessionStatus(
		sessionId: string,
		signal?: AbortSignal
	): Promise<FeishuBridgeSessionStatus> {
		return this.requestJson(
			`/v1/sessions/${encodeURIComponent(sessionId)}`,
			{ method: 'GET', signal }
		);
	}

	queueSessionAssets(
		sessionId: string,
		request: FeishuBridgeQueueAssetsRequest,
		signal?: AbortSignal
	): Promise<FeishuBridgeSessionStatus> {
		return this.requestJson(
			`/v1/sessions/${encodeURIComponent(sessionId)}/queue`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request),
				signal,
			}
		);
	}

	retrySessionCommit(
		sessionId: string,
		signal?: AbortSignal
	): Promise<FeishuBridgeSessionStatus> {
		return this.requestJson(
			`/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
			{ method: 'POST', signal }
		);
	}

	async abortSession(sessionId: string, signal?: AbortSignal): Promise<void> {
		await this.request(
			`/v1/sessions/${encodeURIComponent(sessionId)}`,
			{ method: 'DELETE', signal },
			10_000
		);
	}

	uploadAsset(
		transactionId: string,
		index: number,
		options: FeishuBridgeUploadOptions
	): Promise<FeishuBridgeUploadAssetResponse> {
		const headers: Record<string, string> = {
			'Content-Type': options.contentType || 'application/octet-stream',
			'X-Asset-Filename': encodeURIComponent(options.filename),
		};
		if (options.byteLength !== undefined) {
			headers['X-Asset-Size'] = String(options.byteLength);
		}

		return this.requestJson(
			`/v1/transactions/${encodeURIComponent(transactionId)}/assets/${index}`,
			{
				method: 'PUT',
				headers,
				body: options.body,
				signal: options.signal,
				duplex: 'half',
			} as StreamingRequestInit
		);
	}

	commitTransaction(
		transactionId: string,
		content: string,
		signal?: AbortSignal
	): Promise<FeishuBridgeCommitResponse> {
		return this.requestJson(
			`/v1/transactions/${encodeURIComponent(transactionId)}/commit`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content }),
				signal,
			}
		);
	}

	async abortTransaction(transactionId: string, signal?: AbortSignal): Promise<void> {
		await this.request(
			`/v1/transactions/${encodeURIComponent(transactionId)}`,
			{ method: 'DELETE', signal },
			10_000
		);
	}

	private async requestJson<T>(
		path: string,
		init: StreamingRequestInit,
		timeoutMs = this.requestTimeoutMs
	): Promise<T> {
		const response = await this.request(path, init, timeoutMs);
		try {
			return await response.json() as T;
		} catch {
			throw new FeishuBridgeRequestError(
				'invalid_response',
				response.status,
				'配套插件返回了无效响应'
			);
		}
	}

	private async request(
		path: string,
		init: StreamingRequestInit,
		timeoutMs: number
	): Promise<Response> {
		const controller = new AbortController();
		const sourceSignal = init.signal;
		const onAbort = () => controller.abort(sourceSignal?.reason);
		if (sourceSignal?.aborted) {
			onAbort();
		} else {
			sourceSignal?.addEventListener('abort', onAbort, { once: true });
		}

		const timeout = setTimeout(
			() => controller.abort(new Error('bridge_request_timeout')),
			timeoutMs
		);

		try {
			const headers = {
				Authorization: `Bearer ${this.pairingToken}`,
				...(init.headers as Record<string, string> | undefined),
			};
			const response = await this.fetchImpl(`${this.endpoint}${path}`, {
				...init,
				headers,
				signal: controller.signal,
			} as StreamingRequestInit);

			if (!response.ok) {
				let errorBody: FeishuBridgeErrorResponse | undefined;
				try {
					errorBody = await response.json() as FeishuBridgeErrorResponse;
				} catch {
					// A structured body is optional; keep the fallback generic.
				}
				throw new FeishuBridgeRequestError(
					errorBody?.error?.code || 'bridge_request_failed',
					response.status,
					cleanServerMessage(errorBody?.error?.message, `配套插件请求失败 (${response.status})`)
				);
			}
			return response;
		} catch (error) {
			if (error instanceof FeishuBridgeRequestError) throw error;
			if (controller.signal.aborted) {
				const cancellationMessage = sourceSignal?.reason instanceof Error
					? cleanServerMessage(sourceSignal.reason.message, '附件传输已取消')
					: '附件传输已取消';
				throw new FeishuBridgeRequestError(
					sourceSignal?.aborted ? 'request_cancelled' : 'request_timeout',
					0,
					sourceSignal?.aborted ? cancellationMessage : '配套插件请求超时'
				);
			}
			throw new FeishuBridgeRequestError(
				'bridge_unreachable',
				0,
				'无法连接 Obsidian 配套插件'
			);
		} finally {
			clearTimeout(timeout);
			sourceSignal?.removeEventListener('abort', onAbort);
		}
	}
}
