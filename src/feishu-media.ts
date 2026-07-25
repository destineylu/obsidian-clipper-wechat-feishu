import browser from './utils/browser-polyfill';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function setContent(html: string): void {
	const app = document.getElementById('app');
	if (app) app.innerHTML = html;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

async function loadMedia(): Promise<void> {
	const params = new URLSearchParams(window.location.search);
	const url = params.get('url');
	const urlsParam = params.get('urls');
	const kind = params.get('kind') === 'video' ? 'video' : 'image';
	const name = params.get('name') || 'Feishu media';
	const sourceUrl = params.get('source') || '';

	let urls = url ? [url] : [];
	if (urlsParam) {
		try {
			const parsedUrls = JSON.parse(urlsParam);
			if (Array.isArray(parsedUrls)) {
				urls = parsedUrls.filter((item): item is string => typeof item === 'string' && item.length > 0);
			}
		} catch {
			urls = [];
		}
	}

	if (!urls.length) {
		setContent('<p>Missing Feishu media URL.</p>');
		return;
	}

	if (kind === 'video') {
		const sourceLink = sourceUrl
			? `<p><a href="${escapeHtml(sourceUrl)}">Open the original Feishu document</a></p>`
			: '';
		setContent(`<p>Large Feishu videos are not loaded into extension memory. Open the original document to play or download this video.</p>${sourceLink}`);
		return;
	}

	let response: { success?: boolean; data?: { dataUrl?: string; contentType?: string; size?: number }; error?: string } | null = null;
	let lastError = '';
	for (const candidateUrl of urls) {
		response = await browser.runtime.sendMessage({
			action: 'fetchFeishuMedia',
			url: candidateUrl,
			maxBytes: MAX_IMAGE_BYTES,
			requestId: crypto.randomUUID(),
			timeoutMs: 15_000,
		}) as { success?: boolean; data?: { dataUrl?: string; contentType?: string; size?: number }; error?: string };

		if (response?.success && response.data?.dataUrl) break;
		lastError = response?.error || 'Failed to load Feishu media.';
	}

	if (!response?.success || !response.data?.dataUrl) {
		const message = escapeHtml(lastError || response?.error || 'Failed to load Feishu media.');
		const sourceLink = sourceUrl
			? `<p><a href="${escapeHtml(sourceUrl)}">Open the original Feishu document</a></p>`
			: '';
		setContent(`<p>${message}</p>${sourceLink}`);
		return;
	}

	document.title = name;
	const escapedName = escapeHtml(name);
	setContent(`<img src="${response.data.dataUrl}" alt="${escapedName}"><p>${escapedName}</p>`);
}

loadMedia().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	setContent(`<p>${escapeHtml(message)}</p>`);
});
