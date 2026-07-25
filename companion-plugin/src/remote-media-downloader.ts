import { createHash } from 'node:crypto';
import {
	mkdir,
	open,
	rm,
} from 'node:fs/promises';
import {
	request as httpsRequest,
	type RequestOptions as HttpsRequestOptions,
} from 'node:https';
import type { IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';

type FetchImplementation = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<RemoteFetchResponse>;

interface RemoteFetchResponse {
	readonly body: ReadableStream<Uint8Array> | null;
	readonly headers: Headers;
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
}

type HttpsRequestImplementation = (
	url: URL,
	options: HttpsRequestOptions,
	callback: (response: IncomingMessage) => void
) => ReturnType<typeof httpsRequest>;

export interface RemoteMediaDownloadOptions {
	url: string;
	destination: string;
	maxBytes: number;
	bearerToken?: string;
	signal?: AbortSignal;
	fetchImpl?: FetchImplementation;
	onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
}

export interface RemoteMediaDownloadResult {
	byteLength: number;
	contentType: string;
	sha256: string;
	suggestedFilename?: string;
}

interface RemoteMediaDownloadErrorOptions {
	httpStatus?: number;
	feishuCode?: number | string;
	retryAfterMs?: number;
}

export class RemoteMediaDownloadError extends Error {
	public readonly httpStatus?: number;
	public readonly feishuCode?: number | string;
	public readonly retryAfterMs?: number;

	constructor(
		public readonly code: string,
		message: string,
		options: RemoteMediaDownloadErrorOptions = {}
	) {
		super(message);
		this.name = 'RemoteMediaDownloadError';
		this.httpStatus = options.httpStatus;
		this.feishuCode = options.feishuCode;
		this.retryAfterMs = options.retryAfterMs;
	}
}

function isAllowedFeishuOpenApiDownloadUrl(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			!['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)
		) {
			return false;
		}
		return /^\/open-apis\/drive\/v1\/(?:medias|media|files)\/[^/]+\/download$/i
			.test(url.pathname);
	} catch {
		return false;
	}
}

export function isAllowedFeishuRemoteUrl(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== 'https:' || url.username || url.password) return false;
		if (isAllowedFeishuOpenApiDownloadUrl(rawUrl)) return true;
		if (url.hostname === 'internal-api-drive-stream.feishu.cn') {
			return url.pathname.startsWith('/space/api/box/stream/download/');
		}
		return /^s\d+-imfile\.feishucdn\.com$/i.test(url.hostname);
	} catch {
		return false;
	}
}

function redirectLocation(
	response: RemoteFetchResponse,
	currentUrl: string
): string | null {
	if (![301, 302, 303, 307, 308].includes(response.status)) return null;
	const location = response.headers.get('location');
	return location ? new URL(location, currentUrl).toString() : null;
}

function nativeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
	const normalized = new Headers(headers);
	const result: Record<string, string> = {};
	normalized.forEach((value, name) => {
		result[name] = value;
	});
	return result;
}

export function fetchWithNativeHttps(
	input: RequestInfo | URL,
	init: RequestInit = {},
	requestImpl: HttpsRequestImplementation =
		httpsRequest as unknown as HttpsRequestImplementation
): Promise<RemoteFetchResponse> {
	const rawUrl = input instanceof URL
		? input.toString()
		: typeof input === 'string'
			? input
			: input.url;
	const url = new URL(rawUrl);
	if (url.protocol !== 'https:') {
		return Promise.reject(new Error('Only HTTPS media downloads are allowed'));
	}

	return new Promise((resolve, reject) => {
		const request = requestImpl(url, {
			method: init.method || 'GET',
			headers: {
				'accept-encoding': 'identity',
				...nativeRequestHeaders(init.headers),
			},
			signal: init.signal || undefined,
		}, response => {
			const headers = new Headers();
			for (const [name, value] of Object.entries(response.headers)) {
				if (Array.isArray(value)) {
					value.forEach(item => headers.append(name, item));
				} else if (typeof value === 'string') {
					headers.set(name, value);
				}
			}
			const status = response.statusCode || 500;
			const hasNoBody =
				init.method === 'HEAD' ||
				status === 204 ||
				status === 205 ||
				status === 304;
			const body = hasNoBody
				? null
				: Readable.toWeb(response) as ReadableStream<Uint8Array>;
			// Do not pass Node's ReadableStream through the Electron renderer's
			// Response constructor. In Obsidian that crosses JavaScript realms and
			// can stringify the body to "[object ReadableStream]".
			resolve({
				body,
				ok: status >= 200 && status <= 299,
				status,
				statusText: response.statusMessage || '',
				headers,
			});
		});
		request.setTimeout(60_000, () => {
			const timeoutError = Object.assign(
				new Error('Feishu media request timed out'),
				{ code: 'ETIMEDOUT' }
			);
			request.destroy(timeoutError);
		});
		request.once('error', reject);
		request.end();
	});
}

async function fetchAllowedResponse(
	rawUrl: string,
	fetchImpl: FetchImplementation,
	bearerToken?: string,
	signal?: AbortSignal
): Promise<RemoteFetchResponse> {
	let currentUrl = rawUrl;
	for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
		if (!isAllowedFeishuRemoteUrl(currentUrl)) {
			throw new RemoteMediaDownloadError(
				'remote_url_blocked',
				'飞书媒体下载地址不在允许范围内'
			);
		}
		const response = await fetchImpl(currentUrl, {
			method: 'GET',
			cache: 'no-store',
			redirect: 'manual',
			...(bearerToken && isAllowedFeishuOpenApiDownloadUrl(currentUrl)
				? { headers: { Authorization: `Bearer ${bearerToken}` } }
				: {}),
			signal,
		});
		const location = redirectLocation(response, currentUrl);
		if (!location) return response;
		await response.body?.cancel().catch(() => undefined);
		currentUrl = location;
	}
	throw new RemoteMediaDownloadError(
		'too_many_redirects',
		'飞书媒体下载重定向次数过多'
	);
}

function parseSuggestedFilename(value: string | null): string | undefined {
	if (!value) return undefined;
	const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
	if (encoded) {
		try {
			return decodeURIComponent(encoded);
		} catch {
			// Fall through to the plain filename form.
		}
	}
	return value.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
}

async function readBoundedErrorBody(
	response: RemoteFetchResponse,
	maxBytes = 16 * 1024
): Promise<string> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (byteLength < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			const remaining = maxBytes - byteLength;
			const chunk = value.byteLength > remaining
				? value.subarray(0, remaining)
				: value;
			chunks.push(chunk);
			byteLength += chunk.byteLength;
			if (chunk.byteLength < value.byteLength) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
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

function retryAfterMilliseconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1_000, 60_000);
	}
	const date = Date.parse(value);
	if (!Number.isFinite(date)) return undefined;
	return Math.min(Math.max(0, date - Date.now()), 60_000);
}

interface RemoteDownloadFailureDetails {
	message: string;
	feishuCode?: number | string;
	retryAfterMs?: number;
}

async function describeRemoteDownloadFailure(
	response: RemoteFetchResponse,
	rawUrl: string
): Promise<RemoteDownloadFailureDetails> {
	const status = response.status;
	const retryAfterMs = retryAfterMilliseconds(
		response.headers.get('retry-after')
	);
	if (!isAllowedFeishuOpenApiDownloadUrl(rawUrl)) {
		await response.body?.cancel().catch(() => undefined);
		return {
			message: `飞书媒体下载失败 (HTTP ${status})`,
			retryAfterMs,
		};
	}

	let code: number | string | undefined;
	let message = '';
	try {
		const rawBody = await readBoundedErrorBody(response);
		const result = JSON.parse(rawBody) as {
			code?: number | string;
			msg?: unknown;
			message?: unknown;
		};
		if (
			typeof result.code === 'number' ||
			typeof result.code === 'string'
		) {
			code = result.code;
		}
		message = sanitizeFeishuApiMessage(result.msg ?? result.message);
	} catch {
		// A non-JSON response still retains the actionable HTTP status.
	}

	const details = [
		code !== undefined ? `飞书错误码 ${code}` : '',
		message,
	].filter(Boolean).join(': ');
	return {
		message:
			`飞书开放平台媒体下载失败 (HTTP ${status}${details ? `, ${details}` : ''})`,
		feishuCode: code,
		retryAfterMs,
	};
}

function hasAscii(
	bytes: Uint8Array,
	offset: number,
	value: string
): boolean {
	if (offset + value.length > bytes.byteLength) return false;
	for (let index = 0; index < value.length; index += 1) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

function hasBytes(
	bytes: Uint8Array,
	expected: readonly number[]
): boolean {
	return expected.every((value, index) => bytes[index] === value);
}

function detectRemoteMediaContentType(
	declaredContentType: string,
	bytes: Uint8Array
): string | null {
	if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (hasBytes(bytes, [
		0x89, 0x50, 0x4e, 0x47,
		0x0d, 0x0a, 0x1a, 0x0a,
	])) {
		return 'image/png';
	}
	if (hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a')) {
		return 'image/gif';
	}
	if (hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')) {
		return 'image/webp';
	}
	if (hasAscii(bytes, 0, 'BM')) return 'image/bmp';
	if (
		hasBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
		hasBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])
	) {
		return 'image/tiff';
	}
	if (hasBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
	if (hasAscii(bytes, 4, 'ftyp')) {
		const brand = new TextDecoder().decode(bytes.subarray(8, 12));
		if (['avif', 'avis'].includes(brand)) return 'image/avif';
		if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
			return 'image/heif';
		}
		if (
			declaredContentType === 'video/quicktime' ||
			brand === 'qt  '
		) {
			return 'video/quicktime';
		}
		return 'video/mp4';
	}
	const prefixText = new TextDecoder().decode(bytes).trimStart();
	if (
		declaredContentType === 'image/svg+xml' &&
		(prefixText.startsWith('<svg') ||
			(prefixText.startsWith('<?xml') && prefixText.includes('<svg')))
	) {
		return 'image/svg+xml';
	}
	return null;
}

function validateRemoteMediaPayload(
	contentType: string,
	prefix: Uint8Array
): string {
	const prefixText = new TextDecoder().decode(prefix).trim();
	if (prefixText === '[object ReadableStream]') {
		throw new RemoteMediaDownloadError(
			'invalid_remote_asset',
			'飞书媒体响应不是有效的图片或视频'
		);
	}
	const normalizedContentType = contentType.toLowerCase();
	const detectedContentType = detectRemoteMediaContentType(
		normalizedContentType,
		prefix
	);
	if (detectedContentType) return detectedContentType;
	if (
		normalizedContentType.startsWith('image/') ||
		normalizedContentType.startsWith('video/')
	) {
		throw new RemoteMediaDownloadError(
			'invalid_remote_asset',
			'飞书媒体响应不是有效的图片或视频'
		);
	}
	return normalizedContentType;
}

export async function downloadRemoteMedia(
	options: RemoteMediaDownloadOptions
): Promise<RemoteMediaDownloadResult> {
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
		throw new Error('maxBytes must be a positive safe integer');
	}
	if (
		options.bearerToken !== undefined &&
		!/^[-._~+/=A-Za-z0-9]{1,4096}$/.test(options.bearerToken)
	) {
		throw new RemoteMediaDownloadError(
			'invalid_bearer_token',
			'飞书媒体鉴权令牌无效'
		);
	}
	const fetchImpl = options.fetchImpl ?? fetchWithNativeHttps;
	const response = await fetchAllowedResponse(
		options.url,
		fetchImpl,
		options.bearerToken,
		options.signal
	);
	if (!response.ok || !response.body) {
		const failure = await describeRemoteDownloadFailure(response, options.url);
		throw new RemoteMediaDownloadError(
			'remote_download_failed',
			failure.message,
			{
				httpStatus: response.status,
				feishuCode: failure.feishuCode,
				retryAfterMs: failure.retryAfterMs,
			}
		);
	}

	const contentLengthHeader = response.headers.get('content-length');
	const declaredBytes = contentLengthHeader === null
		? Number.NaN
		: Number(contentLengthHeader);
	const totalBytes = Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
		? declaredBytes
		: undefined;
	if (totalBytes === 0) {
		await response.body.cancel().catch(() => undefined);
		throw new RemoteMediaDownloadError(
			'empty_remote_asset',
			'飞书媒体返回了空文件'
		);
	}
	if (totalBytes !== undefined && totalBytes > options.maxBytes) {
		await response.body.cancel().catch(() => undefined);
		throw new RemoteMediaDownloadError(
			'remote_asset_too_large',
			'飞书媒体超过本地附件大小限制'
		);
	}

	await mkdir(dirname(options.destination), { recursive: true });
	const file = await open(options.destination, 'w');
	const reader = response.body.getReader();
	const hash = createHash('sha256');
	const prefix = new Uint8Array(32);
	let prefixLength = 0;
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			byteLength += value.byteLength;
			if (byteLength > options.maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new RemoteMediaDownloadError(
					'remote_asset_too_large',
					'飞书媒体超过本地附件大小限制'
				);
			}
			if (prefixLength < prefix.byteLength) {
				const prefixChunk = value.subarray(
					0,
					Math.min(value.byteLength, prefix.byteLength - prefixLength)
				);
				prefix.set(prefixChunk, prefixLength);
				prefixLength += prefixChunk.byteLength;
			}
			await file.write(value);
			hash.update(value);
			options.onProgress?.(byteLength, totalBytes);
		}
		if (byteLength === 0) {
			throw new RemoteMediaDownloadError(
				'empty_remote_asset',
				'飞书媒体返回了空文件'
			);
		}
		if (totalBytes !== undefined && byteLength !== totalBytes) {
			throw new RemoteMediaDownloadError(
				'remote_asset_truncated',
				`飞书媒体下载不完整（实际 ${byteLength} 字节，应为 ${totalBytes} 字节）`
			);
		}
		const declaredContentType =
			response.headers.get('content-type')?.split(';', 1)[0]?.trim() ||
			'application/octet-stream';
		const contentType = validateRemoteMediaPayload(
			declaredContentType,
			prefix.subarray(0, prefixLength)
		);
		await file.close();
		return {
			byteLength,
			contentType,
			sha256: hash.digest('hex'),
			suggestedFilename: parseSuggestedFilename(
				response.headers.get('content-disposition')
			),
		};
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(options.destination, { force: true }).catch(() => undefined);
		throw error;
	}
}
