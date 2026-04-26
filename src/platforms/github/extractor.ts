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
