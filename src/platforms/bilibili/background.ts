import browser from '../../utils/browser-polyfill';
import { PlatformBackgroundHandler } from '../types';

const BILIBILI_EMBED_RULE_ID = 91_002;
let webRequestListenerRegistered = false;
let tabRemovalListenerRegistered = false;
let bilibiliRuleUpdateQueue: Promise<void> = Promise.resolve();

interface BilibiliSessionRule {
	id: number;
	condition?: {
		tabIds?: number[];
	};
}

interface BilibiliDeclarativeNetRequest {
	getSessionRules(): Promise<BilibiliSessionRule[]>;
	updateSessionRules(options: {
		removeRuleIds: number[];
		addRules?: unknown[];
	}): Promise<void>;
}

export function isBilibiliHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return normalized === 'bilibili.com' || normalized.endsWith('.bilibili.com');
}

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
		return isBilibiliHostname(url.hostname)
			|| url.protocol === 'chrome-extension:'
			|| url.protocol === 'moz-extension:'
			|| url.protocol === 'safari-web-extension:';
	} catch {
		return false;
	}
}

function getBilibiliDeclarativeNetRequest(): BilibiliDeclarativeNetRequest | null {
	const chromeDnr = typeof chrome !== 'undefined' ? chrome.declarativeNetRequest : undefined;
	const browserDnr = (browser as unknown as { declarativeNetRequest?: BilibiliDeclarativeNetRequest }).declarativeNetRequest;
	const dnr = chromeDnr || browserDnr;
	if (!dnr?.getSessionRules || !dnr?.updateSessionRules) return null;
	return dnr as unknown as BilibiliDeclarativeNetRequest;
}

function buildBilibiliEmbedRule(tabIds: number[]): unknown {
	return {
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
			tabIds,
		}
	};
}

export async function setBilibiliEmbedRuleForTab(
	tabId: number,
	enabled: boolean,
	dnr: BilibiliDeclarativeNetRequest | null = getBilibiliDeclarativeNetRequest()
): Promise<void> {
	if (!dnr) return;

	const update = bilibiliRuleUpdateQueue.then(async () => {
		const currentRules = await dnr.getSessionRules();
		const currentRule = currentRules.find(rule => rule.id === BILIBILI_EMBED_RULE_ID);
		const activeTabIds = new Set(
			(currentRule?.condition?.tabIds || []).filter(id => Number.isInteger(id) && id >= 0)
		);

		if (enabled) {
			activeTabIds.add(tabId);
		} else {
			activeTabIds.delete(tabId);
		}

		const tabIds = Array.from(activeTabIds).sort((left, right) => left - right);
		await dnr.updateSessionRules({
			removeRuleIds: [BILIBILI_EMBED_RULE_ID],
			...(tabIds.length ? { addRules: [buildBilibiliEmbedRule(tabIds)] } : {}),
		});
	});
	bilibiliRuleUpdateQueue = update.catch(() => {});
	return update;
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
	if (!tabRemovalListenerRegistered && browser.tabs?.onRemoved?.addListener) {
		tabRemovalListenerRegistered = true;
		browser.tabs.onRemoved.addListener((tabId) => {
			void setBilibiliEmbedRuleForTab(tabId, false).catch(() => {});
		});
	}

	return [({ request, sender, sendResponse }) => {
		if (request.action === 'enableBilibiliEmbedRule' || request.action === 'disableBilibiliEmbedRule') {
			if (!isAllowedBilibiliSender(sender)) {
				sendResponse({ success: false, error: 'Blocked Bilibili sender' });
				return true;
			}

			const tabId = sender.tab?.id;
			if (typeof tabId !== 'number') {
				sendResponse({ success: false, error: 'Missing Bilibili Reader tab ID' });
				return true;
			}

			setBilibiliEmbedRuleForTab(tabId, request.action === 'enableBilibiliEmbedRule').then(() => {
				sendResponse({ success: true });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
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
