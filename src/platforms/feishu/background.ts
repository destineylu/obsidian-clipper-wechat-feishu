import browser from '../../utils/browser-polyfill';
import { PlatformBackgroundHandler } from '../types';

let feishuTokenCache: { token: string; expiresAt: number } | null = null;

function isAllowedFeishuFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return parsedUrl.protocol === 'https:'
			&& (parsedUrl.hostname === 'open.feishu.cn' || parsedUrl.hostname === 'open.larksuite.com');
	} catch {
		return false;
	}
}

function isAllowedFeishuSender(sender: browser.Runtime.MessageSender): boolean {
	const senderUrl = sender.tab?.url || sender.url || '';
	if (!senderUrl) return false;
	try {
		const url = new URL(senderUrl);
		return url.hostname.endsWith('.feishu.cn')
			|| url.hostname.endsWith('.larksuite.com')
			|| url.protocol === 'chrome-extension:'
			|| url.protocol === 'moz-extension:';
	} catch {
		return false;
	}
}

async function getFeishuTenantToken(): Promise<string> {
	if (feishuTokenCache && Date.now() < feishuTokenCache.expiresAt) {
		return feishuTokenCache.token;
	}

	const data = await browser.storage.local.get('feishu_settings');
	const settings = data.feishu_settings as { appId?: string; appSecret?: string } | undefined;
	if (!settings?.appId || !settings?.appSecret) {
		throw new Error('Feishu credentials not configured. Go to Obsidian Clipper settings -> General -> Feishu / Lark to enter your App ID and App Secret.');
	}

	const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify({ app_id: settings.appId, app_secret: settings.appSecret }),
	});

	if (!response.ok) {
		throw new Error(`Feishu token request failed: HTTP ${response.status}. Check your App ID and App Secret.`);
	}

	const result = await response.json();
	if (result.code !== 0 || !result.tenant_access_token) {
		throw new Error(`Feishu token error: ${result.msg || 'unknown'}(code ${result.code}). Verify your App ID and App Secret are correct.`);
	}

	const expiresIn = (result.expire || 7200) * 1000;
	feishuTokenCache = {
		token: result.tenant_access_token,
		expiresAt: Date.now() + expiresIn - 5 * 60 * 1000,
	};

	return feishuTokenCache.token;
}

async function fetchFeishuApi(url: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<any> {
	if (!isAllowedFeishuFetchUrl(url)) {
		throw new Error('Blocked Feishu fetch URL');
	}

	const token = await getFeishuTenantToken();
	const method = options?.method || 'GET';
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		...options?.headers,
	};

	if (!headers.Accept) {
		headers.Accept = 'application/json';
	}
	if (options?.body && method !== 'GET' && !headers['Content-Type']) {
		headers['Content-Type'] = 'application/json; charset=utf-8';
	}

	const fetchOptions: RequestInit = { method, headers, cache: 'no-store' };
	if (options?.body && method !== 'GET') {
		fetchOptions.body = options.body;
	}

	const response = await fetch(url, fetchOptions);
	if (!response.ok) {
		throw new Error(`Feishu API HTTP ${response.status}: ${url}`);
	}

	const result = await response.json();
	if (result.code && result.code !== 0) {
		throw new Error(`Feishu API error ${result.code}: ${result.msg || 'unknown'} (${url})`);
	}

	return result;
}

async function fetchFeishuMedia(url: string, maxBytes?: number): Promise<{ dataUrl: string; contentType: string; size: number }> {
	if (!isAllowedFeishuFetchUrl(url)) {
		throw new Error('Blocked Feishu fetch URL');
	}

	const token = await getFeishuTenantToken();
	const response = await fetch(url, {
		method: 'GET',
		cache: 'no-store',
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Feishu media HTTP ${response.status}: ${url}`);
	}

	const blob = await response.blob();
	if (maxBytes && blob.size > maxBytes) {
		throw new Error(`Feishu media too large (${blob.size} bytes)`);
	}

	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result);
			} else {
				reject(new Error('Unexpected FileReader result for Feishu media'));
			}
		};
		reader.onerror = () => reject(reader.error || new Error('Failed to read Feishu media blob'));
		reader.readAsDataURL(blob);
	});

	return {
		dataUrl,
		contentType: blob.type || response.headers.get('content-type') || 'application/octet-stream',
		size: blob.size,
	};
}

export function registerFeishuBackgroundHandlers(): PlatformBackgroundHandler[] {
	return [({ request, sender, sendResponse }) => {
		if (request.action !== 'fetchFeishuApi' && request.action !== 'fetchFeishuMedia') {
			return undefined;
		}

		if (!request.url) {
			sendResponse({ success: false, error: 'Missing Feishu URL' });
			return true;
		}

		if (!isAllowedFeishuSender(sender)) {
			sendResponse({ success: false, error: 'Blocked Feishu sender' });
			return true;
		}

		if (request.action === 'fetchFeishuApi') {
			const options = request.options as { method?: string; body?: string; headers?: Record<string, string> } | undefined;
			fetchFeishuApi(request.url, options).then((data) => {
				sendResponse({ success: true, data });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		const maxBytes = request.maxBytes as number | undefined;
		fetchFeishuMedia(request.url, maxBytes).then((data) => {
			sendResponse({ success: true, data });
		}).catch((error) => {
			sendResponse({
				success: false,
				error: error instanceof Error ? error.message : String(error)
			});
		});
		return true;
	}];
}
