import browser from '../utils/browser-polyfill';
import {
	DEFAULT_FEISHU_BRIDGE_ENDPOINT,
	LEGACY_FEISHU_BRIDGE_ENDPOINT,
} from './feishu/bridge-protocol';

const GITHUB_MAX_SAFE_INLINE_TOTAL_BYTES = 40 * 1024 * 1024;
const FEISHU_BRIDGE_CONFIG_VERSION = 2;

export type FeishuImageMode = 'links' | 'inline-base64' | 'obsidian-bridge';
export type FeishuAttachmentMode = 'links' | 'obsidian-bridge';

export interface PlatformSettings {
	feishu: {
		downloadImages: boolean;
		imageMode: FeishuImageMode;
		attachmentMode: FeishuAttachmentMode;
		bridgeEndpoint: string;
		bridgePairingToken: string;
		bridgeConfigVersion: number;
	};
	bilibili: {
		includeTranscript: boolean;
		includeChapters: boolean;
	};
	wechat: {
		preserveLazyImages: boolean;
	};
	github: {
		inlineReadmeImages: boolean;
		maxInlineImageBytes: number;
		maxInlineTotalBytes: number;
	};
}

export const defaultPlatformSettings: PlatformSettings = {
	feishu: {
		downloadImages: false,
		imageMode: 'links',
		attachmentMode: 'links',
		bridgeEndpoint: DEFAULT_FEISHU_BRIDGE_ENDPOINT,
		bridgePairingToken: '',
		bridgeConfigVersion: FEISHU_BRIDGE_CONFIG_VERSION,
	},
	bilibili: {
		includeTranscript: true,
		includeChapters: true,
	},
	wechat: {
		preserveLazyImages: true,
	},
	github: {
		inlineReadmeImages: false,
		maxInlineImageBytes: 8 * 1024 * 1024,
		maxInlineTotalBytes: GITHUB_MAX_SAFE_INLINE_TOTAL_BYTES,
	},
};

export function mergePlatformSettings(raw: Partial<PlatformSettings> | undefined, legacyDownloadImages?: boolean): PlatformSettings {
	const next: PlatformSettings = {
		feishu: {
			...defaultPlatformSettings.feishu,
			...(raw?.feishu || {}),
		},
		bilibili: {
			...defaultPlatformSettings.bilibili,
			...(raw?.bilibili || {}),
		},
		wechat: {
			...defaultPlatformSettings.wechat,
			...(raw?.wechat || {}),
		},
		github: {
			...defaultPlatformSettings.github,
			...(raw?.github || {}),
		},
	};

	if (legacyDownloadImages !== undefined && raw?.feishu?.downloadImages === undefined) {
		next.feishu.downloadImages = legacyDownloadImages;
	}
	if (raw?.feishu?.imageMode === undefined) {
		next.feishu.imageMode = next.feishu.downloadImages
			? 'inline-base64'
			: 'links';
	}
	if (raw?.feishu?.attachmentMode === undefined) {
		next.feishu.attachmentMode = raw?.feishu?.imageMode === 'obsidian-bridge'
			? 'obsidian-bridge'
			: 'links';
	}
	const normalizedEndpoint = next.feishu.bridgeEndpoint
		.trim()
		.replace(/\/+$/, '')
		.replace('http://localhost:', 'http://127.0.0.1:');
	if (
		next.feishu.bridgeConfigVersion < FEISHU_BRIDGE_CONFIG_VERSION &&
		normalizedEndpoint === LEGACY_FEISHU_BRIDGE_ENDPOINT
	) {
		next.feishu.bridgeEndpoint = DEFAULT_FEISHU_BRIDGE_ENDPOINT;
	}
	next.feishu.bridgeConfigVersion = FEISHU_BRIDGE_CONFIG_VERSION;
	next.feishu.downloadImages = next.feishu.imageMode === 'inline-base64';
	next.github.maxInlineTotalBytes = Math.min(
		next.github.maxInlineTotalBytes,
		GITHUB_MAX_SAFE_INLINE_TOTAL_BYTES
	);

	return next;
}

export async function loadPlatformSettings(): Promise<PlatformSettings> {
	const [localData, syncData] = await Promise.all([
		browser.storage.local.get('platform_settings'),
		browser.storage.sync.get('general_settings'),
	]);
	const raw = localData.platform_settings as Partial<PlatformSettings> | undefined;
	const legacyDownloadImages = (syncData.general_settings as { feishuDownloadImages?: boolean } | undefined)?.feishuDownloadImages;
	const settings = mergePlatformSettings(raw, legacyDownloadImages);
	if (
		raw?.feishu?.bridgeConfigVersion !== settings.feishu.bridgeConfigVersion ||
		raw?.feishu?.bridgeEndpoint !== settings.feishu.bridgeEndpoint ||
		raw?.feishu?.attachmentMode !== settings.feishu.attachmentMode
	) {
		await browser.storage.local.set({ platform_settings: settings });
	}
	return settings;
}

export async function savePlatformSettings(settings: Partial<PlatformSettings>): Promise<PlatformSettings> {
	const current = await loadPlatformSettings();
	const next = mergePlatformSettings({
		feishu: {
			...current.feishu,
			...(settings.feishu || {}),
		},
		bilibili: {
			...current.bilibili,
			...(settings.bilibili || {}),
		},
		wechat: {
			...current.wechat,
			...(settings.wechat || {}),
		},
		github: {
			...current.github,
			...(settings.github || {}),
		},
	});
	if (
		settings.feishu?.downloadImages !== undefined &&
		settings.feishu?.imageMode === undefined
	) {
		next.feishu.imageMode = settings.feishu.downloadImages
			? 'inline-base64'
			: 'links';
		next.feishu.downloadImages = settings.feishu.downloadImages;
	}

	await browser.storage.local.set({ platform_settings: next });
	return next;
}

export function isFeishuBridgeEnabled(
	settings: Pick<PlatformSettings['feishu'], 'imageMode' | 'attachmentMode'>
): boolean {
	return settings.imageMode === 'obsidian-bridge'
		|| settings.attachmentMode === 'obsidian-bridge';
}
