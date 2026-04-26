function isGitHubHost(url: URL): boolean {
	return url.hostname === 'github.com' || url.hostname === 'www.github.com';
}

export function isGitHubMarkdownUrl(pageUrl: string): boolean {
	try {
		const url = new URL(pageUrl);
		if (!isGitHubHost(url)) return false;
		const parts = url.pathname.split('/').filter(Boolean);
		const blobIndex = parts.indexOf('blob');
		if (blobIndex < 2 || parts.length <= blobIndex + 2) return false;
		const filePath = parts.slice(blobIndex + 2).join('/').toLowerCase();
		return filePath.endsWith('.md') || filePath.endsWith('.markdown');
	} catch {
		return false;
	}
}

export function normalizeGitHubImageUrl(value: string, pageUrl: string): string {
	try {
		const url = new URL(value, pageUrl);
		if (!isGitHubHost(url)) return url.href;

		const parts = url.pathname.split('/').filter(Boolean);
		const rawIndex = parts.indexOf('raw');
		if (rawIndex !== 2 || parts.length <= rawIndex + 2) return url.href;

		const owner = parts[0];
		const repo = parts[1];
		const branch = parts[rawIndex + 1];
		const filePath = parts.slice(rawIndex + 2).map(encodeURIComponent).join('/');
		return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}${url.search}`;
	} catch {
		return value;
	}
}

function normalizeSrcset(value: string, pageUrl: string): string {
	return value.split(',').map((entry) => {
		const parts = entry.trim().split(/\s+/);
		const url = parts.shift();
		if (!url) return entry;
		return [normalizeGitHubImageUrl(url, pageUrl), ...parts].join(' ');
	}).join(', ');
}

export function normalizeGitHubReadmeImages(root: ParentNode, pageUrl: string): void {
	root.querySelectorAll('img').forEach((img) => {
		const src = img.getAttribute('src');
		if (src) {
			img.setAttribute('src', normalizeGitHubImageUrl(src, pageUrl));
		}

		const srcset = img.getAttribute('srcset');
		if (srcset) {
			img.setAttribute('srcset', normalizeSrcset(srcset, pageUrl));
		}
	});
}

function countImages(html: string | undefined): number {
	return html?.match(/<img\b/gi)?.length || 0;
}

function isGitHubReadmeInlineCandidate(value: string, pageUrl: string): boolean {
	try {
		const normalized = new URL(normalizeGitHubImageUrl(value, pageUrl));
		return normalized.hostname === 'raw.githubusercontent.com';
	} catch {
		return false;
	}
}

async function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === 'string'
			? resolve(reader.result)
			: reject(new Error('Unexpected FileReader result'));
		reader.onerror = () => reject(reader.error || new Error('Failed to read image blob'));
		reader.readAsDataURL(blob);
	});
}

async function fetchImageAsDataUrl(url: string, maxBytes: number): Promise<{ dataUrl: string; size: number } | null> {
	try {
		const response = await fetch(url, { cache: 'force-cache' });
		if (!response.ok) return null;
		const contentType = response.headers.get('content-type') || 'image/jpeg';
		if (!contentType.startsWith('image/')) return null;
		const blob = await response.blob();
		if (blob.size > maxBytes) return null;
		const typedBlob = blob.type ? blob : new Blob([blob], { type: contentType });
		const dataUrl = await blobToDataUrl(typedBlob);
		return { dataUrl, size: blob.size };
	} catch (error) {
		console.warn('[GitHub Clipper] Failed to inline README image:', url, error);
		return null;
	}
}

export async function inlineGitHubReadmeImages(
	content: string,
	pageUrl: string,
	options: { maxImageBytes?: number; maxTotalBytes?: number; concurrency?: number } = {}
): Promise<string> {
	if (!isGitHubMarkdownUrl(pageUrl) || !content.includes('<img')) return content;

	const maxImageBytes = options.maxImageBytes ?? 8 * 1024 * 1024;
	const maxTotalBytes = options.maxTotalBytes ?? 120 * 1024 * 1024;
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const parser = new DOMParser();
	const doc = parser.parseFromString(content, 'text/html');
	const images = Array.from(doc.querySelectorAll('img'));
	const urls = Array.from(new Set(images
		.map(img => img.getAttribute('src') || '')
		.filter(src => src && isGitHubReadmeInlineCandidate(src, pageUrl))
		.map(src => normalizeGitHubImageUrl(src, pageUrl))));

	const dataUrls = new Map<string, string>();
	let totalBytes = 0;
	let nextIndex = 0;

	await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
		while (totalBytes < maxTotalBytes) {
			const url = urls[nextIndex++];
			if (!url) return;
			const result = await fetchImageAsDataUrl(url, maxImageBytes);
			if (!result || totalBytes + result.size > maxTotalBytes) continue;
			totalBytes += result.size;
			dataUrls.set(url, result.dataUrl);
		}
	}));

	for (const img of images) {
		const src = img.getAttribute('src');
		if (!src) continue;
		const normalized = normalizeGitHubImageUrl(src, pageUrl);
		const dataUrl = dataUrls.get(normalized);
		if (!dataUrl) {
			img.setAttribute('src', normalized);
			continue;
		}
		img.setAttribute('src', dataUrl);
		img.removeAttribute('srcset');
	}

	console.log('[GitHub Clipper] Inlined README images:', {
		pageUrl,
		candidateCount: urls.length,
		inlinedCount: dataUrls.size,
		totalBytes,
	});

	return doc.body.innerHTML;
}

export function applyGitHubReadmeFallback<T extends { content?: string }>(
	doc: Document,
	parsed: T,
	pageUrl: string
): T {
	if (!isGitHubMarkdownUrl(pageUrl)) return parsed;

	const article = doc.querySelector('article.markdown-body');
	if (!article) return parsed;

	const clone = article.cloneNode(true) as HTMLElement;
	clone.querySelectorAll('clipboard-copy, .zeroclipboard-container, .anchor').forEach(el => el.remove());
	normalizeGitHubReadmeImages(clone, pageUrl);

	const articleImageCount = clone.querySelectorAll('img').length;
	const parsedImageCount = countImages(parsed.content);
	if (articleImageCount <= parsedImageCount) return parsed;

	return {
		...parsed,
		content: clone.innerHTML,
	};
}
