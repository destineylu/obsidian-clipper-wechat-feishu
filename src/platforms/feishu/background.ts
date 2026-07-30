import browser from '../../utils/browser-polyfill';
import type { Template } from '../../types/types';
import {
	isFeishuBridgeEnabled,
	loadPlatformSettings,
} from '../settings';
import { PlatformBackgroundHandler } from '../types';
import {
	FeishuBridgeClient,
	FeishuBridgeRequestError,
	type FeishuBridgeUploadOptions,
} from './bridge-client';
import {
	createFeishuSessionContent,
	DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES,
	extractFeishuBridgeAssets,
	feishuBridgeMarkerKind,
	FEISHU_BRIDGE_RESUMABLE_CAPABILITY,
	replaceFeishuBridgeAsset,
	type FeishuBridgeCommitResponse,
	type FeishuBridgeCreateSessionRequest,
	type FeishuBridgeCreateSessionResponse,
	type FeishuBridgeCreateTransactionRequest,
	type FeishuBridgeCreateTransactionResponse,
	type FeishuBridgeHealthResponse,
	type FeishuBridgeAssetMarker,
	type FeishuBridgeQueueAssetsRequest,
	type FeishuBridgeRemoteAssetRequest,
	type FeishuBridgeSessionStatus,
	type FeishuBridgeUploadAssetResponse,
} from './bridge-protocol';
import {
	clearFeishuBridgeProgress,
	loadFeishuBridgeProgress,
	saveFeishuBridgeProgress,
} from './bridge-progress';
import {
	buildFeishuMediaDownloadLinks,
	isAllowedFeishuDirectMediaUrl,
} from './extractor';

export { isAllowedFeishuDirectMediaUrl } from './extractor';

let feishuTokenCache: { token: string; expiresAt: number } | null = null;
const activeFeishuMediaRequests = new Map<string, AbortController>();
const DEFAULT_FEISHU_MEDIA_TIMEOUT_MS = 8_000;
const MAX_FEISHU_MEDIA_TIMEOUT_MS = 30_000;
const MAX_FEISHU_MEDIA_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_FEISHU_API_ERROR_BYTES = 64 * 1024;
const FEISHU_BRIDGE_TRANSFER_TIMEOUT_MS = 15 * 60_000;
const FEISHU_BRIDGE_RESUMABLE_WAIT_TIMEOUT_MS = 12 * 60 * 60_000;
const FEISHU_BRIDGE_UPLOAD_CONCURRENCY = 2;
const FEISHU_BRIDGE_URL_RESOLVE_CONCURRENCY = 6;
const FEISHU_BRIDGE_TRANSIENT_RETRY_DELAY_MS = 1_000;

export interface FeishuBridgeTransferInput {
	fileContent: string;
	notePath: string;
	behavior: Extract<
		Template['behavior'],
		'create' | 'overwrite' | 'append-specific' | 'prepend-specific'
	>;
	sourceUrl: string;
	vault: string;
}

interface FeishuBridgeTransferClient {
	health(signal?: AbortSignal): Promise<FeishuBridgeHealthResponse>;
	createTransaction(
		request: FeishuBridgeCreateTransactionRequest,
		signal?: AbortSignal
	): Promise<FeishuBridgeCreateTransactionResponse>;
	uploadAsset(
		transactionId: string,
		index: number,
		options: FeishuBridgeUploadOptions
	): Promise<FeishuBridgeUploadAssetResponse>;
	commitTransaction(
		transactionId: string,
		content: string,
		signal?: AbortSignal
	): Promise<FeishuBridgeCommitResponse>;
	abortTransaction(transactionId: string, signal?: AbortSignal): Promise<void>;
	createSession(
		request: FeishuBridgeCreateSessionRequest,
		signal?: AbortSignal
	): Promise<FeishuBridgeCreateSessionResponse>;
	getSessionStatus(
		sessionId: string,
		signal?: AbortSignal
	): Promise<FeishuBridgeSessionStatus>;
	queueSessionAssets(
		sessionId: string,
		request: FeishuBridgeQueueAssetsRequest,
		signal?: AbortSignal
	): Promise<FeishuBridgeSessionStatus>;
	retrySessionCommit(
		sessionId: string,
		signal?: AbortSignal
	): Promise<FeishuBridgeSessionStatus>;
	abortSession(sessionId: string, signal?: AbortSignal): Promise<void>;
}

interface FeishuBridgeDownloadedAsset {
	body: BodyInit;
	filename: string;
	contentType: string;
	byteLength?: number;
}

export interface FeishuBridgeTransferDependencies {
	client: FeishuBridgeTransferClient;
	downloadAsset(
		asset: Pick<
			FeishuBridgeAssetMarker,
			'token' | 'alt' | 'fallbackUrl' | 'downloadKind'
		>,
		sourceUrl: string,
		signal: AbortSignal
	): Promise<FeishuBridgeDownloadedAsset>;
	retryDelay?(signal: AbortSignal): Promise<void>;
}

function isAllowedFeishuFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return parsedUrl.protocol === 'https:'
			&& (parsedUrl.hostname === 'open.feishu.cn' || parsedUrl.hostname === 'open.larksuite.com');
	} catch {
		return false;
	}
}

export const isAllowedFeishuBridgeDirectMediaUrl = isAllowedFeishuDirectMediaUrl;

function isAllowedFeishuSender(sender: browser.Runtime.MessageSender): boolean {
	const senderUrl = sender.tab?.url || sender.url || '';
	if (!senderUrl) return false;
	try {
		const url = new URL(senderUrl);
		return url.hostname.endsWith('.feishu.cn')
			|| url.hostname.endsWith('.larksuite.com')
			|| url.protocol === 'chrome-extension:'
			|| url.protocol === 'moz-extension:'
			|| url.protocol === 'safari-web-extension:';
	} catch {
		return false;
	}
}

async function getFeishuTenantToken(): Promise<string> {
	if (feishuTokenCache && Date.now() < feishuTokenCache.expiresAt) {
		return feishuTokenCache.token;
	}

	const data = await browser.storage.local.get('feishu_settings');
	const settings = data.feishu_settings as { appId?: string; appSecret?: string } | undefined;
	if (!settings?.appId || !settings?.appSecret) {
		throw new Error('Feishu credentials not configured. Go to Obsidian Clipper settings -> General -> Feishu / Lark to enter your App ID and App Secret.');
	}

	const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify({ app_id: settings.appId, app_secret: settings.appSecret }),
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		throw new Error(`Feishu token request failed: HTTP ${response.status}. Check your App ID and App Secret.`);
	}

	const result = await response.json();
	if (result.code !== 0 || !result.tenant_access_token) {
		throw new Error(`Feishu token error: ${result.msg || 'unknown'}(code ${result.code}). Verify your App ID and App Secret are correct.`);
	}

	const expiresIn = (result.expire || 7200) * 1000;
	feishuTokenCache = {
		token: result.tenant_access_token,
		expiresAt: Date.now() + expiresIn - 5 * 60 * 1000,
	};

	return feishuTokenCache.token;
}

async function fetchFeishuApi(url: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<any> {
	if (!isAllowedFeishuFetchUrl(url)) {
		throw new Error('Blocked Feishu fetch URL');
	}

	const token = await getFeishuTenantToken();
	const method = options?.method || 'GET';
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		...options?.headers,
	};

	if (!headers.Accept) {
		headers.Accept = 'application/json';
	}
	if (options?.body && method !== 'GET' && !headers['Content-Type']) {
		headers['Content-Type'] = 'application/json; charset=utf-8';
	}

	const fetchOptions: RequestInit = {
		method,
		headers,
		cache: 'no-store',
		signal: AbortSignal.timeout(15_000),
	};
	if (options?.body && method !== 'GET') {
		fetchOptions.body = options.body;
	}

	const response = await fetch(url, fetchOptions);
	if (!response.ok) {
		throw new Error(`Feishu API HTTP ${response.status}`);
	}

	const result = await response.json();
	if (result.code && result.code !== 0) {
		throw new Error(`Feishu API error ${result.code}: ${result.msg || 'unknown'}`);
	}

	return result;
}

function normalizePositiveInteger(value: unknown, fallback: number, maximum: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), maximum);
}

function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

async function readBoundedFeishuMediaBytes(
	response: Response,
	maxBytes: number
): Promise<{ bytes: Uint8Array; contentType: string; size: number }> {
	const contentLengthHeader = response.headers.get('content-length');
	const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error(`Feishu media too large (${contentLength} bytes)`);
	}
	if (!response.body) {
		throw new Error('Feishu media response does not support safe streaming');
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error(`Feishu media too large (${size} bytes)`);
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	const rawContentType = response.headers.get('content-type') || 'application/octet-stream';
	const contentType = rawContentType.split(';', 1)[0].trim() || 'application/octet-stream';
	return { bytes, contentType, size };
}

interface FeishuApiErrorEnvelope {
	code?: number | string;
	msg?: unknown;
	message?: unknown;
}

function sanitizeFeishuApiMessage(value: unknown): string {
	if (typeof value !== 'string') return '';
	return value
		.replace(/https?:\/\/\S+/gi, '<redacted-url>')
		.replace(/[A-Za-z0-9_-]{24,}/g, '<redacted-id>')
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 160);
}

function normalizeFeishuApiCode(value: unknown): number | string | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value)) {
		return value;
	}
	return undefined;
}

function feishuApiEnvelopeError(
	prefix: string,
	status: number,
	envelope?: FeishuApiErrorEnvelope
): Error {
	const code = normalizeFeishuApiCode(envelope?.code);
	const message = sanitizeFeishuApiMessage(
		envelope?.msg ?? envelope?.message
	);
	const details = [
		code !== undefined ? `飞书错误码 ${code}` : '',
		message,
	].filter(Boolean).join(': ');
	return new Error(
		`${prefix} (HTTP ${status}${details ? `, ${details}` : ''})`
	);
}

async function readBoundedFeishuJson(
	response: Response
): Promise<FeishuApiErrorEnvelope & Record<string, any>> {
	const { bytes } = await readBoundedFeishuMediaBytes(
		response,
		MAX_FEISHU_API_ERROR_BYTES
	);
	return JSON.parse(
		new TextDecoder().decode(bytes)
	) as FeishuApiErrorEnvelope & Record<string, any>;
}

async function describeFeishuApiResponseFailure(
	response: Response,
	prefix: string
): Promise<Error> {
	let envelope: FeishuApiErrorEnvelope | undefined;
	try {
		envelope = await readBoundedFeishuJson(response);
	} catch {
		await response.body?.cancel().catch(() => undefined);
	}
	return feishuApiEnvelopeError(prefix, response.status, envelope);
}

export async function readFeishuMediaResponse(
	response: Response,
	maxBytes: number
): Promise<{ dataUrl: string; contentType: string; size: number }> {
	const { bytes, contentType, size } = await readBoundedFeishuMediaBytes(
		response,
		maxBytes
	);
	return {
		dataUrl: `data:${contentType};base64,${bytesToBase64(bytes)}`,
		contentType,
		size,
	};
}

export async function readFeishuBridgeBinaryResponse(
	response: Response,
	maxBytes: number
): Promise<{ body: Blob; contentType: string; size: number }> {
	const { bytes, contentType, size } = await readBoundedFeishuMediaBytes(
		response,
		maxBytes
	);
	// Chromium extension fetch cannot forward a response ReadableStream directly
	// to a cross-origin loopback request. A bounded Blob keeps the payload binary
	// without the Base64 expansion or runtime-message copy used by the legacy mode.
	return {
		body: new Blob([bytes], { type: contentType }),
		contentType,
		size,
	};
}

async function fetchFeishuMedia(
	url: string,
	maxBytes: number,
	signal: AbortSignal
): Promise<{ dataUrl: string; contentType: string; size: number }> {
	if (!isAllowedFeishuFetchUrl(url)) {
		throw new Error('Blocked Feishu fetch URL');
	}

	const token = await getFeishuTenantToken();
	const response = await fetch(url, {
		method: 'GET',
		cache: 'no-store',
		headers: {
			Authorization: `Bearer ${token}`,
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`Feishu media HTTP ${response.status}`);
	}

	return readFeishuMediaResponse(response, maxBytes);
}

function mediaExtension(contentType: string): string {
	const extensions: Record<string, string> = {
		'image/avif': '.avif',
		'image/bmp': '.bmp',
		'image/gif': '.gif',
		'image/jpeg': '.jpg',
		'image/png': '.png',
		'image/svg+xml': '.svg',
		'image/webp': '.webp',
	};
	return extensions[contentType] || '.bin';
}

function buildBridgeAssetFilename(alt: string, contentType: string): string {
	const cleanAlt = alt
		.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80) || 'feishu-image';
	return /\.[a-z0-9]{2,8}$/i.test(cleanAlt)
		? cleanAlt
		: `${cleanAlt}${mediaExtension(contentType)}`;
}

interface FeishuBridgeOpenedAsset {
	response: Response;
	filename: string;
	contentType: string;
	byteLength?: number;
}

async function validateFeishuBridgeAssetResponse(
	response: Response,
	alt: string,
	maxBytes: number,
	errorPrefix: string
): Promise<FeishuBridgeOpenedAsset> {
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`${errorPrefix} (HTTP ${response.status})`);
	}
	const contentLengthHeader = response.headers.get('content-length');
	const declaredBytes = contentLengthHeader === null
		? undefined
		: Number(contentLengthHeader);
	if (
		declaredBytes !== undefined &&
		(
			!Number.isSafeInteger(declaredBytes) ||
			declaredBytes <= 0 ||
			declaredBytes > maxBytes
		)
	) {
		await response.body.cancel().catch(() => undefined);
		throw new Error(
			declaredBytes === 0
				? '飞书媒体返回了空文件'
				: '飞书媒体超过本地附件大小限制'
		);
	}
	const rawContentType =
		response.headers.get('content-type') || 'application/octet-stream';
	const contentType =
		rawContentType.split(';', 1)[0].trim() || 'application/octet-stream';
	return {
		response,
		filename: buildBridgeAssetFilename(alt, contentType),
		contentType,
		...(declaredBytes !== undefined ? { byteLength: declaredBytes } : {}),
	};
}

async function openFeishuBridgeDirectAsset(
	directUrl: string,
	alt: string,
	maxBytes: number,
	signal: AbortSignal
): Promise<FeishuBridgeOpenedAsset> {
	if (!isAllowedFeishuBridgeDirectMediaUrl(directUrl)) {
		throw new Error('飞书页面媒体地址不在允许范围内');
	}
	const response = await fetch(directUrl, {
		method: 'GET',
		cache: 'no-store',
		credentials: 'omit',
		signal,
	});
	return validateFeishuBridgeAssetResponse(
		response,
		alt,
		maxBytes,
		'飞书页面媒体下载失败'
	);
}

async function downloadFeishuBridgeDirectAsset(
	directUrl: string,
	alt: string,
	signal: AbortSignal
): Promise<FeishuBridgeDownloadedAsset> {
	const opened = await openFeishuBridgeDirectAsset(
		directUrl,
		alt,
		DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES,
		signal
	);
	const downloaded = await readFeishuBridgeBinaryResponse(
		opened.response,
		DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES
	);
	return {
		body: downloaded.body,
		filename: opened.filename,
		contentType: downloaded.contentType,
		byteLength: downloaded.size,
	};
}

async function getFeishuTemporaryMediaUrl(
	sourceUrl: string,
	mediaToken: string,
	tenantToken: string,
	signal: AbortSignal
): Promise<{ url?: string; status?: number; error?: Error }> {
	const urls = buildFeishuMediaDownloadLinks(sourceUrl, mediaToken, 'image');
	const openApiOrigin = urls.length ? new URL(urls[0]).origin : '';
	if (!openApiOrigin) return {};
	const endpoints = [
		// Current Open Platform route.
		`${openApiOrigin}/open-apis/drive/v1/media/batch_get_tmp_download_url?file_tokens=${encodeURIComponent(mediaToken)}`,
		// Legacy route retained for compatibility.
		`${openApiOrigin}/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=${encodeURIComponent(mediaToken)}`,
	].filter(isAllowedFeishuFetchUrl);
	let lastStatus: number | undefined;
	let diagnosticError: Error | undefined;
	let diagnosticPriority = 0;
	const rememberDiagnostic = (error: Error, priority: number) => {
		if (priority >= diagnosticPriority) {
			diagnosticError = error;
			diagnosticPriority = priority;
		}
	};

	for (const endpoint of endpoints) {
		const response = await fetch(endpoint, {
			method: 'GET',
			cache: 'no-store',
			headers: { Authorization: `Bearer ${tenantToken}` },
			signal,
		});
		lastStatus = response.status;
		if (!response.ok) {
			rememberDiagnostic(
				await describeFeishuApiResponseFailure(
					response,
					'飞书临时下载地址获取失败'
				),
				1
			);
			continue;
		}

		let result: {
			code?: number | string;
			msg?: unknown;
			message?: unknown;
			data?: {
				tmp_download_urls?: Array<{
					file_token?: string;
					tmp_download_url?: string;
				}>;
			};
		};
		try {
			result = await readBoundedFeishuJson(response);
		} catch {
			rememberDiagnostic(
				new Error(
					`飞书临时下载地址响应无效 (HTTP ${response.status})`
				),
				2
			);
			continue;
		}
		const code = normalizeFeishuApiCode(result.code);
		if (code !== undefined && String(code) !== '0') {
			rememberDiagnostic(
				feishuApiEnvelopeError(
					'飞书临时下载地址获取失败',
					response.status,
					result
				),
				4
			);
			continue;
		}
		const match = result.code === 0 || typeof result.code === 'undefined'
			? result.data?.tmp_download_urls?.find(
				item => item.file_token === mediaToken
			)
			: undefined;
		if (
			match?.tmp_download_url &&
			isAllowedFeishuBridgeDirectMediaUrl(match.tmp_download_url)
		) {
			return { url: match.tmp_download_url, status: response.status };
		}
		rememberDiagnostic(
			new Error(
				match?.tmp_download_url
					? `飞书临时下载地址不在允许范围内 (HTTP ${response.status})`
					: `飞书临时下载地址未包含当前媒体 (HTTP ${response.status})`
			),
			match?.tmp_download_url ? 3 : 2
		);
	}

	return {
		status: lastStatus,
		...(diagnosticError ? { error: diagnosticError } : {}),
	};
}

async function openFeishuBridgeAsset(
	asset: Pick<
		FeishuBridgeAssetMarker,
		'token' | 'alt' | 'fallbackUrl' | 'downloadKind'
	>,
	sourceUrl: string,
	maxBytes: number,
	signal: AbortSignal
): Promise<FeishuBridgeOpenedAsset> {
	if (asset.token.startsWith('remote:')) {
		return openFeishuBridgeDirectAsset(
			asset.token.slice('remote:'.length),
			asset.alt,
			maxBytes,
			signal
		);
	}

	const urls = buildFeishuMediaDownloadLinks(
		sourceUrl,
		asset.token,
		asset.downloadKind
	);
	let lastStatus = 0;
	let apiError: unknown;

	try {
		const token = await getFeishuTenantToken();
		for (const url of urls) {
			if (signal.aborted) throw new Error('飞书附件传输已取消');
			if (!isAllowedFeishuFetchUrl(url)) continue;
			const response = await fetch(url, {
				method: 'GET',
				cache: 'no-store',
				headers: { Authorization: `Bearer ${token}` },
				signal,
			});
			lastStatus = response.status;
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				continue;
			}
			return await validateFeishuBridgeAssetResponse(
				response,
				asset.alt,
				maxBytes,
				'飞书媒体下载失败'
			);
		}

		const temporary = await getFeishuTemporaryMediaUrl(
			sourceUrl,
			asset.token,
			token,
			signal
		);
		lastStatus = temporary.status || lastStatus;
		if (temporary.error) {
			apiError = temporary.error;
		}
		if (temporary.url) {
			return await openFeishuBridgeDirectAsset(
				temporary.url,
				asset.alt,
				maxBytes,
				signal
			);
		}
	} catch (error) {
		if (signal.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error('飞书附件传输已取消');
		}
		apiError = error;
	}

	if (asset.fallbackUrl) {
		try {
			return await openFeishuBridgeDirectAsset(
				asset.fallbackUrl,
				asset.alt,
				maxBytes,
				signal
			);
		} catch (fallbackError) {
			if (!apiError) throw fallbackError;
			const fallbackMessage = fallbackError instanceof Error
				? fallbackError.message
				: String(fallbackError);
			const apiMessage = apiError instanceof Error
				? apiError.message
				: String(apiError);
			throw new Error(
				`${fallbackMessage}；飞书开放平台路径同时失败：${apiMessage}`
			);
		}
	}

	if (apiError) {
		throw apiError;
	}

	throw new Error(
		lastStatus
			? `飞书图片下载失败 (HTTP ${lastStatus})`
			: '没有可用的飞书图片下载地址'
	);
}

export async function downloadFeishuBridgeAsset(
	asset: Pick<
		FeishuBridgeAssetMarker,
		'token' | 'alt' | 'fallbackUrl' | 'downloadKind'
	>,
	sourceUrl: string,
	signal: AbortSignal
): Promise<FeishuBridgeDownloadedAsset> {
	const opened = await openFeishuBridgeAsset(
		asset,
		sourceUrl,
		DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES,
		signal
	);
	const downloaded = await readFeishuBridgeBinaryResponse(
		opened.response,
		DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES
	);
	return {
		body: downloaded.body,
		filename: opened.filename,
		contentType: downloaded.contentType,
		byteLength: downloaded.size,
	};
}

function sourceOrigin(sourceUrl: string): string {
	try {
		return new URL(sourceUrl).origin;
	} catch {
		return '';
	}
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function stableFeishuAssetIdentity(asset: FeishuBridgeAssetMarker): string {
	if (!asset.token.startsWith('remote:')) return asset.token;
	try {
		const url = new URL(asset.token.slice('remote:'.length));
		return `remote:${url.origin}${url.pathname}`;
	} catch {
		return asset.token;
	}
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return bytesToHex(new Uint8Array(digest));
}

export async function buildFeishuBridgeSourceKey(
	sourceUrl: string
): Promise<string> {
	return sha256Hex(sourceUrl);
}

export async function buildFeishuBridgeResumeKey(
	input: FeishuBridgeTransferInput,
	assets: FeishuBridgeAssetMarker[]
): Promise<string> {
	return sha256Hex([
			input.sourceUrl,
			input.notePath,
			input.behavior,
			...assets.map(asset => [
				asset.kind,
				asset.downloadKind,
				stableFeishuAssetIdentity(asset),
				asset.occurrences,
			].join('\u0001')),
	].join('\u0000'));
}

export function shouldUseFeishuResumableBridge(
	health: FeishuBridgeHealthResponse,
	_assets: FeishuBridgeAssetMarker[]
): boolean {
	return health.capabilities?.includes(
		FEISHU_BRIDGE_RESUMABLE_CAPABILITY
	) === true;
}

function resumableAssetFilename(
	asset: FeishuBridgeAssetMarker,
	index: number
): string {
	const cleaned = asset.alt
		.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
	return cleaned || `feishu-${asset.kind}-${index}`;
}

export async function resolveFeishuRemoteAssetRequests(
	assets: FeishuBridgeAssetMarker[],
	indexes: number[],
	sourceUrl: string,
	signal: AbortSignal
): Promise<FeishuBridgeRemoteAssetRequest[]> {
	const tenantToken = await getFeishuTenantToken();
	const results = new Array<FeishuBridgeRemoteAssetRequest>(indexes.length);
	let nextIndex = 0;
	const workerCount = Math.min(
		FEISHU_BRIDGE_URL_RESOLVE_CONCURRENCY,
		indexes.length
	);
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (!signal.aborted) {
			const resultIndex = nextIndex++;
			const assetIndex = indexes[resultIndex];
			if (assetIndex === undefined) return;
			const asset = assets[assetIndex];
			const isRemoteAsset = asset.token.startsWith('remote:');
			let downloadUrl = isRemoteAsset
				? asset.token.slice('remote:'.length)
				: asset.fallbackUrl || '';
			const authenticatedUrls = isRemoteAsset
				? []
				: buildFeishuMediaDownloadLinks(
					sourceUrl,
					asset.token,
					asset.downloadKind
				).filter(isAllowedFeishuFetchUrl);
			let fallbackDownloadUrls: string[] = [];
			if (downloadUrl && !isAllowedFeishuBridgeDirectMediaUrl(downloadUrl)) {
				downloadUrl = '';
			}
			if (!downloadUrl && !isRemoteAsset) {
				const temporary = await getFeishuTemporaryMediaUrl(
					sourceUrl,
					asset.token,
					tenantToken,
					signal
				);
				downloadUrl = temporary.url || '';
			}
			if (!downloadUrl) {
				downloadUrl = authenticatedUrls[0] || '';
				fallbackDownloadUrls = authenticatedUrls.slice(1);
			} else {
				fallbackDownloadUrls = authenticatedUrls.filter(
					url => url !== downloadUrl
				);
			}
			if (!downloadUrl) {
				throw new Error(`第 ${assetIndex + 1} 个飞书媒体没有可用下载地址`);
			}
			results[resultIndex] = {
				index: assetIndex,
				kind: asset.kind,
				filename: resumableAssetFilename(asset, assetIndex),
				downloadUrl,
				...(fallbackDownloadUrls.length ||
				authenticatedUrls.includes(downloadUrl)
					? {
						...(fallbackDownloadUrls.length
							? { fallbackDownloadUrls }
							: {}),
						bearerToken: tenantToken,
					}
					: {}),
			};
		}
	}));
	return results;
}

async function publishFeishuBridgeProgress(
	sourceUrl: string,
	status: FeishuBridgeSessionStatus
): Promise<void> {
	const progress = await saveFeishuBridgeProgress(sourceUrl, status);
	await browser.runtime.sendMessage({
		action: 'feishuBridgeProgress',
		sourceUrl,
		progress,
	}).catch(() => undefined);
}

function waitForBridgePoll(
	signal: AbortSignal,
	delayMs = 1_000
): Promise<void> {
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
					: new Error('飞书附件传输已取消')
			);
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

function isTransientFeishuBridgeDownloadError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (
		/\b(?:飞书错误码|code[=\s:]+)99991400\b/i.test(message)
	) {
		return true;
	}
	const status = Number(message.match(/\bHTTP\s+(\d{3})\b/i)?.[1]);
	if (
		status === 408 ||
		status === 425 ||
		status === 429 ||
		(status >= 500 && status <= 599)
	) {
		return true;
	}
	return (
		error instanceof TypeError ||
		/(?:failed to fetch|network|socket|terminated|econn|etimedout|und_err)/i
			.test(message)
	);
}

async function downloadFeishuBridgeAssetWithRetry(
	dependencies: FeishuBridgeTransferDependencies,
	asset: FeishuBridgeAssetMarker,
	sourceUrl: string,
	signal: AbortSignal
): Promise<FeishuBridgeDownloadedAsset> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			return await dependencies.downloadAsset(asset, sourceUrl, signal);
		} catch (error) {
			if (
				attempt > 0 ||
				signal.aborted ||
				!isTransientFeishuBridgeDownloadError(error)
			) {
				throw error;
			}
			const retryDelay = dependencies.retryDelay ??
				((retrySignal: AbortSignal) => waitForBridgePoll(
					retrySignal,
					FEISHU_BRIDGE_TRANSIENT_RETRY_DELAY_MS
				));
			await retryDelay(signal);
		}
	}
	throw new Error('飞书媒体下载重试失败');
}

export interface FeishuBridgeResumableTransferDependencies {
	client: FeishuBridgeTransferClient;
	resolveAssets?(
		assets: FeishuBridgeAssetMarker[],
		indexes: number[],
		sourceUrl: string,
		signal: AbortSignal
	): Promise<FeishuBridgeRemoteAssetRequest[]>;
	publishProgress?(
		sourceUrl: string,
		status: FeishuBridgeSessionStatus
	): Promise<void>;
	pollDelay?(signal: AbortSignal): Promise<void>;
}

export function hasFeishuBridgeUnauthorizedAssets(
	status: FeishuBridgeSessionStatus
): boolean {
	return status.assets.some(asset =>
		asset.state === 'failed' &&
		typeof asset.error === 'string' &&
		/\bHTTP 401\b/i.test(asset.error)
	);
}

export async function transferFeishuNoteWithResumableBridge(
	input: FeishuBridgeTransferInput,
	dependencies: FeishuBridgeResumableTransferDependencies
): Promise<FeishuBridgeCommitResponse> {
	const assets = extractFeishuBridgeAssets(input.fileContent);
	if (!assets.length) {
		throw new Error('剪藏内容中没有待传输的飞书媒体');
	}
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error('飞书可恢复附件传输等待超时')),
		FEISHU_BRIDGE_RESUMABLE_WAIT_TIMEOUT_MS
	);
	const publish = dependencies.publishProgress ?? publishFeishuBridgeProgress;
	const resolveAssets =
		dependencies.resolveAssets ?? resolveFeishuRemoteAssetRequests;
	const pollDelay =
		dependencies.pollDelay ?? ((signal: AbortSignal) => waitForBridgePoll(signal));

	try {
		const health = await dependencies.client.health(controller.signal);
		if (!health.ready) throw new Error('Obsidian 配套插件尚未就绪');
		if (
			!health.capabilities?.includes(FEISHU_BRIDGE_RESUMABLE_CAPABILITY)
		) {
			throw new Error('Obsidian 配套插件尚不支持可恢复媒体传输');
		}
		if (input.vault && health.vaultName && input.vault !== health.vaultName) {
			throw new Error(
				`当前 Obsidian Vault 为“${health.vaultName}”，与剪藏目标 Vault 不一致`
			);
		}
		const [resumeKey, sourceKey] = await Promise.all([
			buildFeishuBridgeResumeKey(input, assets),
			buildFeishuBridgeSourceKey(input.sourceUrl),
		]);
		const created = await dependencies.client.createSession({
			resumeKey,
			sourceKey,
			note: {
				path: input.notePath,
				behavior: input.behavior,
				content: createFeishuSessionContent(input.fileContent, assets),
			},
			sourceOrigin: sourceOrigin(input.sourceUrl),
			assets: assets.map((asset, index) => ({
				index,
				kind: asset.kind,
				alt: asset.alt,
			})),
		}, controller.signal);
		let status = created.status;
		await publish(input.sourceUrl, status);
		if (status.phase !== 'completed') {
			const missingIndexes = status.assets
				.filter(asset => asset.state !== 'completed')
				.map(asset => asset.index);
			if (missingIndexes.length) {
				if (hasFeishuBridgeUnauthorizedAssets(status)) {
					// Permissions may have been published after this token was
					// issued, or a long-running transfer may have outlived it.
					feishuTokenCache = null;
				}
				const queue = await resolveAssets(
					assets,
					missingIndexes,
					input.sourceUrl,
					controller.signal
				);
				status = await dependencies.client.queueSessionAssets(
					created.sessionId,
					{ assets: queue },
					controller.signal
				);
				await publish(input.sourceUrl, status);
			}
		}

		while (status.phase !== 'completed') {
			if (
				status.phase === 'failed' &&
				(status.failedAssets > 0 || status.error)
			) {
				throw new Error(
					status.error ||
					`${status.failedAssets} 个飞书媒体下载失败，重新点击可继续`
				);
			}
			await pollDelay(controller.signal);
			status = await dependencies.client.getSessionStatus(
				created.sessionId,
				controller.signal
			);
			await publish(input.sourceUrl, status);
		}

		return {
			notePath: status.notePath || input.notePath,
			assetPaths: status.assets
				.sort((left, right) => left.index - right.index)
				.flatMap(asset => asset.vaultPath ? [asset.vaultPath] : []),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function transferFeishuNoteWithBridge(
	input: FeishuBridgeTransferInput,
	dependencies: FeishuBridgeTransferDependencies
): Promise<FeishuBridgeCommitResponse> {
	const assets = extractFeishuBridgeAssets(input.fileContent);
	if (!assets.length) {
		throw new Error('剪藏内容中没有待传输的飞书图片');
	}

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error(
			'飞书附件传输超过 15 分钟，请确认网络和 Obsidian 配套插件后重试'
		)),
		FEISHU_BRIDGE_TRANSFER_TIMEOUT_MS
	);
	let transactionId = '';

	try {
		const health = await dependencies.client.health(controller.signal);
		if (!health.ready) throw new Error('Obsidian 配套插件尚未就绪');
		if (input.vault && health.vaultName && input.vault !== health.vaultName) {
			throw new Error(
				`当前 Obsidian Vault 为“${health.vaultName}”，与剪藏目标 Vault 不一致`
			);
		}

		const transaction = await dependencies.client.createTransaction({
			note: {
				path: input.notePath,
				behavior: input.behavior,
				// Do not disclose Feishu media or document tokens to the companion.
				content: '',
			},
			sourceUrl: sourceOrigin(input.sourceUrl),
			assetCount: assets.length,
		}, controller.signal);
		transactionId = transaction.transactionId;

		const uploadedPaths = new Array<string>(assets.length);
		let nextIndex = 0;
		const workerCount = Math.min(
			FEISHU_BRIDGE_UPLOAD_CONCURRENCY,
			assets.length
		);
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (!controller.signal.aborted) {
					const index = nextIndex++;
					const asset = assets[index];
					if (!asset) return;
					const downloaded = await downloadFeishuBridgeAssetWithRetry(
						dependencies,
						asset,
						input.sourceUrl,
						controller.signal
					);
					const uploaded = await dependencies.client.uploadAsset(
						transactionId,
						index,
						{
							...downloaded,
							signal: controller.signal,
						}
					);
					uploadedPaths[index] = uploaded.vaultPath;
				}
			})
		);

		let finalContent = input.fileContent;
		assets.forEach((asset, index) => {
			finalContent = replaceFeishuBridgeAsset(
				finalContent,
				asset.token,
				uploadedPaths[index],
				feishuBridgeMarkerKind(asset)
			);
		});

		return await dependencies.client.commitTransaction(
			transactionId,
			finalContent,
			controller.signal
		);
	} catch (error) {
		controller.abort();
		if (transactionId) {
			const cleanupController = new AbortController();
			const cleanupTimeout = setTimeout(
				() => cleanupController.abort(),
				10_000
			);
			await dependencies.client
				.abortTransaction(transactionId, cleanupController.signal)
				.catch(() => undefined);
			clearTimeout(cleanupTimeout);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function transferFeishuBridgeRequest(
	request: Record<string, unknown>
): Promise<FeishuBridgeCommitResponse> {
	const settings = await loadPlatformSettings();
	if (!isFeishuBridgeEnabled(settings.feishu)) {
		throw new Error('飞书媒体未启用 Obsidian 配套插件');
	}
	if (!settings.feishu.bridgePairingToken) {
		throw new Error('尚未配置 Obsidian 配套插件配对令牌');
	}

	const input = request.input as FeishuBridgeTransferInput | undefined;
	if (
		!input ||
		typeof input.fileContent !== 'string' ||
		typeof input.notePath !== 'string' ||
		typeof input.sourceUrl !== 'string' ||
		typeof input.vault !== 'string' ||
		!['create', 'overwrite', 'append-specific', 'prepend-specific'].includes(
			input.behavior
		)
	) {
		throw new Error('飞书桥接保存参数无效');
	}

	const client = new FeishuBridgeClient({
		endpoint: settings.feishu.bridgeEndpoint,
		pairingToken: settings.feishu.bridgePairingToken,
		requestTimeoutMs: 90_000,
	});
	const assets = extractFeishuBridgeAssets(input.fileContent);
	const health = await client.health();
	const useResumable = shouldUseFeishuResumableBridge(health, assets);
	if (useResumable) {
		return transferFeishuNoteWithResumableBridge(input, { client });
	}
	return transferFeishuNoteWithBridge(input, {
		client,
		downloadAsset: downloadFeishuBridgeAsset,
	});
}

async function getFeishuBridgeProgress(
	sourceUrl: string
): Promise<Awaited<ReturnType<typeof loadFeishuBridgeProgress>>> {
	const stored = await loadFeishuBridgeProgress(sourceUrl);
	if (!stored) return null;
	const settings = await loadPlatformSettings();
	if (!settings.feishu.bridgePairingToken) return stored;
	const client = new FeishuBridgeClient({
		endpoint: settings.feishu.bridgeEndpoint,
		pairingToken: settings.feishu.bridgePairingToken,
	});
	try {
		const status = await client.getSessionStatus(stored.sessionId);
		return await saveFeishuBridgeProgress(sourceUrl, status);
	} catch (error) {
		if (
			error instanceof FeishuBridgeRequestError &&
			(error.status === 404 || error.code === 'session_not_found')
		) {
			await clearFeishuBridgeProgress(sourceUrl);
			return null;
		}
		return stored;
	}
}

async function testFeishuBridgeConnection(): Promise<FeishuBridgeHealthResponse> {
	const settings = await loadPlatformSettings();
	if (!settings.feishu.bridgePairingToken) {
		throw new Error('尚未配置 Obsidian 配套插件配对令牌');
	}
	const client = new FeishuBridgeClient({
		endpoint: settings.feishu.bridgeEndpoint,
		pairingToken: settings.feishu.bridgePairingToken,
	});
	return client.health();
}

export function registerFeishuBackgroundHandlers(): PlatformBackgroundHandler[] {
	return [({ request, sender, sendResponse }) => {
		if (
			request.action !== 'fetchFeishuApi'
			&& request.action !== 'fetchFeishuMedia'
			&& request.action !== 'cancelFeishuMedia'
			&& request.action !== 'saveFeishuWithBridge'
			&& request.action !== 'testFeishuBridge'
			&& request.action !== 'getFeishuBridgeProgress'
		) {
			return undefined;
		}

		if (!isAllowedFeishuSender(sender)) {
			sendResponse({ success: false, error: 'Blocked Feishu sender' });
			return true;
		}

		if (request.action === 'saveFeishuWithBridge') {
			transferFeishuBridgeRequest(request).then(result => {
				sendResponse({ success: true, data: result });
			}).catch(error => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return true;
		}

		if (request.action === 'getFeishuBridgeProgress') {
			if (typeof request.sourceUrl !== 'string') {
				sendResponse({ success: false, error: '飞书进度查询参数无效' });
				return true;
			}
			getFeishuBridgeProgress(request.sourceUrl).then(progress => {
				sendResponse({ success: true, data: progress });
			}).catch(error => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return true;
		}

		if (request.action === 'testFeishuBridge') {
			testFeishuBridgeConnection().then(result => {
				sendResponse({ success: true, data: result });
			}).catch(error => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return true;
		}

		if (request.action === 'cancelFeishuMedia') {
			const requestId = typeof request.requestId === 'string' ? request.requestId : '';
			if (requestId) {
				activeFeishuMediaRequests.get(requestId)?.abort();
			}
			sendResponse({ success: true });
			return true;
		}

		if (!request.url) {
			sendResponse({ success: false, error: 'Missing Feishu URL' });
			return true;
		}

		if (request.action === 'fetchFeishuApi') {
			const options = request.options as { method?: string; body?: string; headers?: Record<string, string> } | undefined;
			fetchFeishuApi(request.url, options).then((data) => {
				sendResponse({ success: true, data });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		const requestId = typeof request.requestId === 'string' && request.requestId.length <= 128
			? request.requestId
			: crypto.randomUUID();
		const maxBytes = normalizePositiveInteger(
			request.maxBytes,
			MAX_FEISHU_MEDIA_RESPONSE_BYTES,
			MAX_FEISHU_MEDIA_RESPONSE_BYTES
		);
		const timeoutMs = normalizePositiveInteger(
			request.timeoutMs,
			DEFAULT_FEISHU_MEDIA_TIMEOUT_MS,
			MAX_FEISHU_MEDIA_TIMEOUT_MS
		);
		activeFeishuMediaRequests.get(requestId)?.abort();
		const controller = new AbortController();
		activeFeishuMediaRequests.set(requestId, controller);
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		fetchFeishuMedia(request.url, maxBytes, controller.signal).then((data) => {
			sendResponse({ success: true, data });
		}).catch((error) => {
			sendResponse({
				success: false,
				error: controller.signal.aborted
					? 'Feishu media request cancelled or timed out'
					: error instanceof Error ? error.message : String(error)
			});
		}).finally(() => {
			clearTimeout(timeoutId);
			if (activeFeishuMediaRequests.get(requestId) === controller) {
				activeFeishuMediaRequests.delete(requestId);
			}
		});
		return true;
	}];
}
