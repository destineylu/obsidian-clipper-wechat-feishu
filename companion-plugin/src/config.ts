import {
	DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES,
	DEFAULT_FEISHU_BRIDGE_FILE_MAX_BYTES,
	DEFAULT_FEISHU_BRIDGE_IMAGE_MAX_BYTES,
	DEFAULT_FEISHU_BRIDGE_SESSION_MAX_BYTES,
	DEFAULT_FEISHU_BRIDGE_TRANSACTION_MAX_BYTES,
} from '../../src/platforms/feishu/bridge-protocol';
import type { BridgePluginSettings } from './types';

export const BRIDGE_SETTINGS_VERSION = 2;
export const LEGACY_BRIDGE_PORT = 27124;
export const DEFAULT_BRIDGE_PORT = 27125;

export const DEFAULT_BRIDGE_SETTINGS: BridgePluginSettings = {
	settingsVersion: BRIDGE_SETTINGS_VERSION,
	port: DEFAULT_BRIDGE_PORT,
	pairingTokenHash: '',
	attachmentFolder: 'Attachments/Web Clipper',
	maxAssetBytes: DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES,
	maxTransactionBytes: DEFAULT_FEISHU_BRIDGE_TRANSACTION_MAX_BYTES,
	imageMaxBytes: DEFAULT_FEISHU_BRIDGE_IMAGE_MAX_BYTES,
	fileMaxBytes: DEFAULT_FEISHU_BRIDGE_FILE_MAX_BYTES,
	sessionMaxBytes: DEFAULT_FEISHU_BRIDGE_SESSION_MAX_BYTES,
	sessionRetentionMs: 24 * 60 * 60_000,
	downloadConcurrency: 3,
};

export function normalizeBridgeSettings(
	stored: Partial<BridgePluginSettings> | null | undefined
): BridgePluginSettings {
	const settings: BridgePluginSettings = {
		...DEFAULT_BRIDGE_SETTINGS,
		...(stored || {}),
	};

	if (
		(stored?.settingsVersion ?? 0) < BRIDGE_SETTINGS_VERSION &&
		stored?.port === LEGACY_BRIDGE_PORT
	) {
		settings.port = DEFAULT_BRIDGE_PORT;
	}
	settings.settingsVersion = BRIDGE_SETTINGS_VERSION;

	if (
		!Number.isInteger(settings.port) ||
		settings.port < 1024 ||
		settings.port > 65535
	) {
		settings.port = DEFAULT_BRIDGE_SETTINGS.port;
	}
	if (
		!Number.isSafeInteger(settings.maxAssetBytes) ||
		settings.maxAssetBytes < 1024
	) {
		settings.maxAssetBytes = DEFAULT_BRIDGE_SETTINGS.maxAssetBytes;
	}
	if (
		!Number.isSafeInteger(settings.maxTransactionBytes) ||
		settings.maxTransactionBytes < settings.maxAssetBytes
	) {
		settings.maxTransactionBytes =
			DEFAULT_BRIDGE_SETTINGS.maxTransactionBytes;
	}
	if (
		!Number.isSafeInteger(settings.imageMaxBytes) ||
		settings.imageMaxBytes < 1024
	) {
		settings.imageMaxBytes = DEFAULT_BRIDGE_SETTINGS.imageMaxBytes;
	}
	if (
		!Number.isSafeInteger(settings.fileMaxBytes) ||
		settings.fileMaxBytes < settings.imageMaxBytes
	) {
		settings.fileMaxBytes = DEFAULT_BRIDGE_SETTINGS.fileMaxBytes;
	}
	if (
		!Number.isSafeInteger(settings.sessionMaxBytes) ||
		settings.sessionMaxBytes < settings.fileMaxBytes
	) {
		settings.sessionMaxBytes = DEFAULT_BRIDGE_SETTINGS.sessionMaxBytes;
	}
	if (
		!Number.isSafeInteger(settings.sessionRetentionMs) ||
		settings.sessionRetentionMs < 60_000
	) {
		settings.sessionRetentionMs =
			DEFAULT_BRIDGE_SETTINGS.sessionRetentionMs;
	}
	if (
		!Number.isInteger(settings.downloadConcurrency) ||
		settings.downloadConcurrency < 1 ||
		settings.downloadConcurrency > 8
	) {
		settings.downloadConcurrency =
			DEFAULT_BRIDGE_SETTINGS.downloadConcurrency;
	}

	return settings;
}

export function describeBridgeServerStartError(
	error: unknown,
	port: number
): string {
	const code =
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string'
			? error.code
			: '';
	if (code === 'EADDRINUSE') {
		return `端口 ${port} 已被其他程序或插件占用`;
	}
	return error instanceof Error ? error.message : '未知错误';
}
