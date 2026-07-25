import browser from '../../utils/browser-polyfill';
import type { FeishuBridgeSessionStatus } from './bridge-protocol';

const STORAGE_PREFIX = 'feishu_bridge_progress_';

export interface FeishuBridgeStoredProgress {
	sessionId: string;
	phase: FeishuBridgeSessionStatus['phase'];
	assetCount: number;
	completedAssets: number;
	failedAssets: number;
	downloadedBytes: number;
	totalBytes?: number;
	notePath?: string;
	error?: string;
	updatedAt: string;
}

export function isFeishuBridgeSessionActive(
	phase: FeishuBridgeSessionStatus['phase']
): boolean {
	return (
		phase === 'downloading' ||
		phase === 'ready' ||
		phase === 'committing'
	);
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function hashFeishuBridgeSource(sourceUrl: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(sourceUrl)
	);
	return bytesToHex(new Uint8Array(digest));
}

async function storageKey(sourceUrl: string): Promise<string> {
	return `${STORAGE_PREFIX}${await hashFeishuBridgeSource(sourceUrl)}`;
}

export async function clearFeishuBridgeProgress(
	sourceUrl: string
): Promise<void> {
	await browser.storage.local.remove(await storageKey(sourceUrl));
}

export function redactFeishuBridgeProgress(
	status: FeishuBridgeSessionStatus
): FeishuBridgeStoredProgress {
	const permissionDenied = status.assets.some(asset =>
		asset.state === 'failed' &&
		typeof asset.error === 'string' &&
		/\bHTTP 401\b/i.test(asset.error)
	);
	const error = status.error || (
		permissionDenied
			? '飞书开放平台拒绝下载部分媒体（HTTP 401）：未使用 Cookie；请确认应用身份的媒体下载权限已发布，且应用的数据访问范围包含该文档'
			: undefined
	);
	return {
		sessionId: status.sessionId,
		phase: status.phase,
		assetCount: status.assetCount,
		completedAssets: status.completedAssets,
		failedAssets: status.failedAssets,
		downloadedBytes: status.downloadedBytes,
		...(status.totalBytes !== undefined
			? { totalBytes: status.totalBytes }
			: {}),
		...(status.notePath ? { notePath: status.notePath } : {}),
		...(error ? { error: error.slice(0, 300) } : {}),
		updatedAt: status.updatedAt,
	};
}

export async function saveFeishuBridgeProgress(
	sourceUrl: string,
	status: FeishuBridgeSessionStatus
): Promise<FeishuBridgeStoredProgress> {
	const progress = redactFeishuBridgeProgress(status);
	await browser.storage.local.set({
		[await storageKey(sourceUrl)]: progress,
	});
	return progress;
}

export async function loadFeishuBridgeProgress(
	sourceUrl: string
): Promise<FeishuBridgeStoredProgress | null> {
	const key = await storageKey(sourceUrl);
	const stored = await browser.storage.local.get(key) as Record<string, unknown>;
	const progress = stored[key] as FeishuBridgeStoredProgress | undefined;
	return progress && typeof progress.sessionId === 'string'
		? progress
		: null;
}
