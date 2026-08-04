import type { Template } from '../../types/types';

export const FEISHU_BRIDGE_PROTOCOL_VERSION = 1;
export const LEGACY_FEISHU_BRIDGE_ENDPOINT = 'http://127.0.0.1:27124';
export const DEFAULT_FEISHU_BRIDGE_ENDPOINT = 'http://127.0.0.1:27125';
export const DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_FEISHU_BRIDGE_TRANSACTION_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_FEISHU_BRIDGE_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_FEISHU_BRIDGE_FILE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_FEISHU_BRIDGE_SESSION_MAX_BYTES = 20 * 1024 * 1024 * 1024;
export const FEISHU_BRIDGE_RESUMABLE_CAPABILITY = 'resumable-remote-media-v1';
export const DOCUMENT_BUNDLE_CAPABILITY = 'document-bundle-v1';
export const DOCUMENT_BUNDLE_MAX_PAGES = 100;
export const DOCUMENT_BUNDLE_MAX_NOTES = DOCUMENT_BUNDLE_MAX_PAGES + 1;
export const DOCUMENT_BUNDLE_MAX_BYTES = 20 * 1024 * 1024;

export type FeishuBridgeSupportedBehavior = Extract<
	Template['behavior'],
	'create' | 'overwrite' | 'append-specific' | 'prepend-specific'
>;

export interface FeishuBridgeHealthResponse {
	service: 'clipper-attachment-bridge';
	protocolVersion: number;
	ready: boolean;
	vaultName?: string;
	capabilities?: string[];
	limits?: {
		imageBytes: number;
		fileBytes: number;
		sessionBytes: number;
	};
}

export interface DocumentBundleNoteRequest {
	path: string;
	content: string;
	sourceUrl?: string;
}

export interface DocumentBundleWriteRequest {
	behavior: 'overwrite';
	notes: DocumentBundleNoteRequest[];
}

export interface DocumentBundleWriteResponse {
	notePaths: string[];
}

export interface FeishuBridgeCreateTransactionRequest {
	note: {
		path: string;
		behavior: FeishuBridgeSupportedBehavior;
		content: string;
	};
	sourceUrl: string;
	assetCount: number;
}

export interface FeishuBridgeCreateTransactionResponse {
	transactionId: string;
	expiresAt: string;
}

export interface FeishuBridgeUploadAssetResponse {
	index: number;
	vaultPath: string;
	byteLength: number;
}

export interface FeishuBridgeCommitResponse {
	notePath: string;
	assetPaths: string[];
}

export interface FeishuBridgeErrorResponse {
	error: {
		code: string;
		message: string;
	};
}

export interface FeishuBridgeAssetMarker {
	token: string;
	alt: string;
	occurrences: number;
	kind: FeishuBridgeAssetKind;
	downloadKind: 'image' | 'file';
	fallbackUrl?: string;
}

export type FeishuBridgeAssetKind = 'image' | 'video' | 'file';
export type FeishuBridgeMarkerKind = 'image' | 'image-file' | 'video' | 'file';

export interface FeishuBridgeSessionAssetMetadata {
	index: number;
	kind: FeishuBridgeAssetKind;
	alt: string;
}

export interface FeishuBridgeCreateSessionRequest {
	resumeKey: string;
	sourceKey?: string;
	note: {
		path: string;
		behavior: FeishuBridgeSupportedBehavior;
		content: string;
	};
	sourceOrigin: string;
	assets: FeishuBridgeSessionAssetMetadata[];
}

export interface FeishuBridgeCreateSessionResponse {
	sessionId: string;
	resumed: boolean;
	status: FeishuBridgeSessionStatus;
}

export interface FeishuBridgeRemoteAssetRequest {
	index: number;
	kind: FeishuBridgeAssetKind;
	filename: string;
	downloadUrl: string;
	fallbackDownloadUrls?: string[];
	bearerToken?: string;
	expectedBytes?: number;
}

export interface FeishuBridgeQueueAssetsRequest {
	assets: FeishuBridgeRemoteAssetRequest[];
}

export type FeishuBridgeSessionPhase =
	| 'waiting'
	| 'downloading'
	| 'ready'
	| 'committing'
	| 'completed'
	| 'failed';

export interface FeishuBridgeSessionAssetStatus {
	index: number;
	kind: FeishuBridgeAssetKind;
	state: 'pending' | 'downloading' | 'completed' | 'failed';
	byteLength: number;
	vaultPath?: string;
	error?: string;
}

export interface FeishuBridgeSessionStatus {
	sessionId: string;
	phase: FeishuBridgeSessionPhase;
	assetCount: number;
	completedAssets: number;
	failedAssets: number;
	downloadedBytes: number;
	totalBytes?: number;
	isTotalBytesFinal?: boolean;
	activeAssets?: number;
	retryingAssets?: number;
	retryAfterMs?: number;
	bytesPerSecond?: number;
	assets: FeishuBridgeSessionAssetStatus[];
	notePath?: string;
	error?: string;
	updatedAt: string;
}

const FEISHU_BRIDGE_MARKER_PATTERN =
	/(!?)\[([^\]]*)\]\(feishu-bridge:\/\/(image|image-file|video|file)\/([^?)\s]+)(?:\?fallback=([^)]+))?\)/g;

export const FEISHU_SESSION_ASSET_PLACEHOLDER_PREFIX =
	'{{FEISHU_BRIDGE_ASSET_';

function decodeMarkerToken(encodedToken: string): string | null {
	try {
		const token = decodeURIComponent(encodedToken);
		return token && !/[\u0000-\u001f]/.test(token) ? token : null;
	} catch {
		return null;
	}
}

function decodeMarkerFallbackUrl(encodedUrl: string | undefined): string | undefined {
	if (!encodedUrl) return undefined;
	try {
		const url = decodeURIComponent(encodedUrl);
		return url.length <= 8192 && !/[\u0000-\u001f]/.test(url)
			? url
			: undefined;
	} catch {
		return undefined;
	}
}

export function normalizeFeishuBridgeEndpoint(rawEndpoint: string): string {
	let endpoint: URL;
	try {
		endpoint = new URL(rawEndpoint.trim());
	} catch {
		throw new Error('配套插件地址无效');
	}

	if (
		endpoint.protocol !== 'http:' ||
		!endpoint.port ||
		(endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') ||
		endpoint.pathname !== '/' ||
		endpoint.search ||
		endpoint.hash ||
		endpoint.username ||
		endpoint.password
	) {
		throw new Error('配套插件地址必须是仅含端口的本机 HTTP 地址');
	}

	const port = Number(endpoint.port);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error('配套插件端口必须位于 1024–65535');
	}

	return `http://127.0.0.1:${port}`;
}

export function extractFeishuBridgeAssets(markdown: string): FeishuBridgeAssetMarker[] {
	const assets = new Map<string, FeishuBridgeAssetMarker>();

	for (const match of markdown.matchAll(FEISHU_BRIDGE_MARKER_PATTERN)) {
		const markerKind = match[3] as FeishuBridgeMarkerKind;
		const token = decodeMarkerToken(match[4]);
		if (!token) continue;
		const fallbackUrl = decodeMarkerFallbackUrl(match[5]);
		const key = `${markerKind}:${token}`;
		const kind: FeishuBridgeAssetKind = markerKind === 'video'
			? 'video'
			: markerKind === 'file'
				? 'file'
				: 'image';
		const downloadKind = markerKind === 'image' ? 'image' : 'file';

		const existing = assets.get(key);
		if (existing) {
			existing.occurrences += 1;
			if (!existing.fallbackUrl && fallbackUrl) {
				existing.fallbackUrl = fallbackUrl;
			}
		} else {
			assets.set(key, {
				token,
				alt: match[2],
				occurrences: 1,
				kind,
				downloadKind,
				...(fallbackUrl ? { fallbackUrl } : {}),
			});
		}
	}

	return [...assets.values()];
}

function normalizeVaultAssetPath(rawPath: string): string {
	const path = rawPath.replace(/\\/g, '/').trim();
	const segments = path.split('/');

	if (
		!path ||
		path.startsWith('/') ||
		/^[a-zA-Z]:/.test(path) ||
		segments.some(segment => !segment || segment === '.' || segment === '..') ||
		/[\u0000-\u001f|#\[\]]/.test(path)
	) {
		throw new Error('配套插件返回了不安全的附件路径');
	}

	return path;
}

export function replaceFeishuBridgeAsset(
	markdown: string,
	token: string,
	rawVaultPath: string,
	markerKind: FeishuBridgeMarkerKind = 'image'
): string {
	const vaultPath = normalizeVaultAssetPath(rawVaultPath);

	return markdown.replace(
		FEISHU_BRIDGE_MARKER_PATTERN,
		(
			original,
			_bang: string,
			alt: string,
			currentMarkerKind: FeishuBridgeMarkerKind,
			encodedToken: string
		) => {
			if (
				currentMarkerKind !== markerKind ||
				decodeMarkerToken(encodedToken) !== token
			) {
				return original;
			}
			if (currentMarkerKind === 'video' || currentMarkerKind === 'file') {
				return `![[${vaultPath}]]`;
			}
			const alias = alt ? `|${alt.replace(/\|/g, '\\|').replace(/\]/g, '\\]')}` : '';
			return `![[${vaultPath}${alias}]]`;
		}
	);
}

function markerKindForAsset(
	asset: Pick<FeishuBridgeAssetMarker, 'kind' | 'downloadKind'>
): FeishuBridgeMarkerKind {
	if (asset.kind === 'video') return 'video';
	if (asset.kind === 'file') return 'file';
	return asset.downloadKind === 'file' ? 'image-file' : 'image';
}

export function createFeishuSessionContent(
	markdown: string,
	assets: FeishuBridgeAssetMarker[]
): string {
	const assetIndexes = new Map(
		assets.map((asset, index) => [
			`${markerKindForAsset(asset)}:${asset.token}`,
			index,
		])
	);
	return markdown.replace(
		FEISHU_BRIDGE_MARKER_PATTERN,
		(
			original,
			_bang: string,
			_alt: string,
			markerKind: FeishuBridgeMarkerKind,
			encodedToken: string
		) => {
			const token = decodeMarkerToken(encodedToken);
			if (!token) return original;
			const index = assetIndexes.get(`${markerKind}:${token}`);
			return index === undefined
				? original
				: `${FEISHU_SESSION_ASSET_PLACEHOLDER_PREFIX}${index}}}`;
		}
	);
}

export function feishuBridgeMarkerKind(
	asset: Pick<FeishuBridgeAssetMarker, 'kind' | 'downloadKind'>
): FeishuBridgeMarkerKind {
	return markerKindForAsset(asset);
}

export function replaceFeishuSessionAssetPlaceholder(
	content: string,
	index: number,
	rawVaultPath: string,
	kind: FeishuBridgeAssetKind,
	alt = ''
): string {
	const vaultPath = normalizeVaultAssetPath(rawVaultPath);
	const placeholder = `${FEISHU_SESSION_ASSET_PLACEHOLDER_PREFIX}${index}}}`;
	const alias = kind === 'image' && alt
		? `|${alt.replace(/\|/g, '\\|').replace(/\]/g, '\\]')}`
		: '';
	return content.split(placeholder).join(`![[${vaultPath}${alias}]]`);
}
