import { PlatformModule } from '../types';
import { applyWeChatContentFallback, normalizeLazyImages } from './extractor';
import { loadPlatformSettings } from '../settings';

function isWeChatUrl(url: string): boolean {
	try {
		return new URL(url).hostname === 'mp.weixin.qq.com';
	} catch {
		return false;
	}
}

export const wechatPlatform: PlatformModule = {
	id: 'wechat',
	matches: isWeChatUrl,
	async beforeDomNormalize({ document, url }) {
		const settings = await loadPlatformSettings();
		if (settings.wechat.preserveLazyImages) {
			normalizeLazyImages(document, url);
		}
	},
	afterExtract({ document, parsed, url }) {
		return applyWeChatContentFallback(document, parsed, url);
	},
};
