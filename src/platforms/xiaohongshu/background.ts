import browser from '../../utils/browser-polyfill';
import { PlatformBackgroundHandler } from '../types';
import { isXiaohongshuUrl } from './extractor';

function isAllowedXiaohongshuSender(sender: browser.Runtime.MessageSender): boolean {
	const senderUrl = sender.tab?.url || sender.url || '';
	if (!senderUrl) return false;
	try {
		const url = new URL(senderUrl);
		return isXiaohongshuUrl(url.href)
			|| url.protocol === 'chrome-extension:'
			|| url.protocol === 'moz-extension:';
	} catch {
		return false;
	}
}

async function fetchXiaohongshuHtml(url: string): Promise<{ html: string; finalUrl: string }> {
	if (!isXiaohongshuUrl(url)) {
		throw new Error('Blocked Xiaohongshu fetch URL');
	}

	const response = await fetch(url, {
		method: 'GET',
		credentials: 'include',
		cache: 'no-store',
		headers: {
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		},
		redirect: 'follow',
	});

	if (!response.ok) {
		throw new Error(`Xiaohongshu fetch failed with status ${response.status}`);
	}

	return {
		html: await response.text(),
		finalUrl: response.url,
	};
}

export function registerXiaohongshuBackgroundHandlers(): PlatformBackgroundHandler[] {
	return [({ request, sender, sendResponse }) => {
		if (request.action !== 'fetchXiaohongshuHtml' || !request.url) {
			return undefined;
		}

		if (!isAllowedXiaohongshuSender(sender)) {
			sendResponse({ success: false, error: 'Blocked Xiaohongshu sender' });
			return true;
		}

		fetchXiaohongshuHtml(request.url).then((data) => {
			sendResponse({ success: true, ...data });
		}).catch((error) => {
			sendResponse({
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});

		return true;
	}];
}
