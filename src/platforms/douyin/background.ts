import browser from '../../utils/browser-polyfill';
import { PlatformBackgroundHandler } from '../types';
import { isDouyinUrl } from './extractor';

function isAllowedDouyinSender(sender: browser.Runtime.MessageSender): boolean {
	const senderUrl = sender.tab?.url || sender.url || '';
	if (!senderUrl) return false;
	try {
		const url = new URL(senderUrl);
		return isDouyinUrl(url.href)
			|| url.protocol === 'chrome-extension:'
			|| url.protocol === 'moz-extension:';
	} catch {
		return false;
	}
}

async function fetchDouyinHtml(url: string): Promise<{ html: string; finalUrl: string }> {
	if (!isDouyinUrl(url)) {
		throw new Error('Blocked Douyin fetch URL');
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
		throw new Error(`Douyin fetch failed with status ${response.status}`);
	}

	return {
		html: await response.text(),
		finalUrl: response.url,
	};
}

export function registerDouyinBackgroundHandlers(): PlatformBackgroundHandler[] {
	return [({ request, sender, sendResponse }) => {
		if (request.action !== 'fetchDouyinHtml' || !request.url) {
			return undefined;
		}

		if (!isAllowedDouyinSender(sender)) {
			sendResponse({ success: false, error: 'Blocked Douyin sender' });
			return true;
		}

		fetchDouyinHtml(request.url).then((data) => {
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
