import browser from '../utils/browser-polyfill';

export interface PlatformSettings {
	feishu: {
		downloadImages: boolean;
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
		maxInlineTotalBytes: 120 * 1024 * 1024,
	},
};

function mergePlatformSettings(raw: Partial<PlatformSettings> | undefined, legacyDownloadImages?: boolean): PlatformSettings {
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
	if (legacyDownloadImages !== undefined && raw?.github?.inlineReadmeImages === undefined) {
		next.github.inlineReadmeImages = legacyDownloadImages;
	}

	return next;
}

export async function loadPlatformSettings(): Promise<PlatformSettings> {
	const [localData, syncData] = await Promise.all([
		browser.storage.local.get('platform_settings'),
		browser.storage.sync.get('general_settings'),
	]);
	const raw = localData.platform_settings as Partial<PlatformSettings> | undefined;
	const legacyDownloadImages = (syncData.general_settings as { feishuDownloadImages?: boolean } | undefined)?.feishuDownloadImages;
	return mergePlatformSettings(raw, legacyDownloadImages);
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

	await browser.storage.local.set({ platform_settings: next });
	return next;
}
