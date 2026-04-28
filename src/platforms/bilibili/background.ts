import browser from '../../utils/browser-polyfill';
import { PlatformBackgroundHandler } from '../types';

const BILIBILI_EMBED_RULE_ID = 9002;
let webRequestListenerRegistered = false;

function isAllowedBilibiliFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return parsedUrl.protocol === 'https:'
			&& (
				parsedUrl.hostname === 'api.bilibili.com'
				|| parsedUrl.hostname.endsWith('.hdslb.com')
			);
	} catch {
		return false;
	}
}

function isAllowedBilibiliSender(sender: browser.Runtime.MessageSender): boolean {
	const senderUrl = sender.tab?.url || sender.url || '';
	if (!senderUrl) return false;
	try {
		const url = new URL(senderUrl);
		return url.hostname.endsWith('bilibili.com')
			|| url.protocol === 'chrome-extension:'
			|| url.protocol === 'moz-extension:';
	} catch {
		return false;
	}
}

async function enableBilibiliEmbedRule(tabId: number): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [BILIBILI_EMBED_RULE_ID],
		addRules: [{
			id: BILIBILI_EMBED_RULE_ID,
			priority: 1,
			action: {
				type: 'modifyHeaders' as any,
				requestHeaders: [{
					header: 'Referer',
					operation: 'set' as any,
					value: 'https://www.bilibili.com/'
				}]
			},
			condition: {
				urlFilter: '||player.bilibili.com/',
				resourceTypes: ['sub_frame' as any],
				tabIds: [tabId]
			}
		}]
	});
}

async function disableBilibiliEmbedRule(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [BILIBILI_EMBED_RULE_ID]
	});
}

async function fetchBilibiliJson(url: string): Promise<any> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw new Error('Blocked Bilibili fetch URL');
	}

	const response = await fetch(url, {
		method: 'GET',
		credentials: 'include',
		cache: 'no-store',
		headers: {
			Referer: 'https://www.bilibili.com/'
		}
	});

	if (!response.ok) {
		throw new Error(`Bilibili fetch failed with status ${response.status}`);
	}

	return response.json();
}

function registerBilibiliWebRequestRule(): void {
	if (webRequestListenerRegistered || !browser.webRequest?.onBeforeSendHeaders) return;
	webRequestListenerRegistered = true;
	browser.webRequest.onBeforeSendHeaders.addListener(
		(details) => {
			const headers = (details.requestHeaders || []).filter(
				h => h.name.toLowerCase() !== 'referer'
			);
			headers.push({ name: 'Referer', value: 'https://www.bilibili.com/' });
			return { requestHeaders: headers };
		},
		{
			urls: ['*://player.bilibili.com/*'],
			types: ['sub_frame' as browser.WebRequest.ResourceType]
		},
		['blocking', 'requestHeaders']
	);
}

export function registerBilibiliBackgroundHandlers(): PlatformBackgroundHandler[] {
	registerBilibiliWebRequestRule();

	return [({ request, sender, sendResponse }) => {
		if (request.action === 'enableBilibiliEmbedRule') {
			const tabId = sender.tab?.id;
			if (tabId) {
				enableBilibiliEmbedRule(tabId).then(() => {
					sendResponse({ success: true });
				}).catch(() => {
					sendResponse({ success: true });
				});
			} else {
				sendResponse({ success: true });
			}
			return true;
		}

		if (request.action === 'disableBilibiliEmbedRule') {
			disableBilibiliEmbedRule().then(() => {
				sendResponse({ success: true });
			}).catch(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (request.action === 'fetchBilibiliJson' && request.url) {
			if (!isAllowedBilibiliSender(sender)) {
				sendResponse({ success: false, error: 'Blocked Bilibili sender' });
				return true;
			}
			fetchBilibiliJson(request.url).then((data) => {
				sendResponse({ success: true, data });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		return undefined;
	}];
}
