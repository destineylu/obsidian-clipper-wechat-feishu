import { clip, clipMarkdown, type DocumentParser } from '../api';
import type { Template } from '../types/types';
import { sanitizeFileName } from '../utils/string-utils';

export const DOCUMENT_BUNDLE_MERGED_MAX_PAGES = 100;
export const DOCUMENT_BUNDLE_MAX_PAGES = DOCUMENT_BUNDLE_MERGED_MAX_PAGES;
export const DOCUMENT_COLLECTION_MAX_PAGES = 5_000;
export const DOCUMENT_BUNDLE_FETCH_CONCURRENCY = 3;

export type DocumentSourceKind = 'sphinx' | 'llms-txt' | 'llms-txt-generic' | 'google-devsite' | 'docusaurus';
export type DocumentContentType = 'html' | 'markdown';

const GENERATED_SPHINX_DOCS = new Set([
	'genindex',
	'modindex',
	'py-modindex',
	'search',
]);

export interface SphinxSearchIndex {
	docnames: string[];
	titles: string[];
}

export interface DocumentPageManifest {
	docname: string;
	title: string;
	url: string;
	fetchUrl?: string;
	contentType?: DocumentContentType;
}

export interface DocumentNavigationNode {
	title: string;
	docname?: string;
	children: DocumentNavigationNode[];
}

export interface DocumentManifest {
	kind: DocumentSourceKind;
	title: string;
	rootUrl: string;
	collectionId?: string;
	locale?: string;
	pages: DocumentPageManifest[];
	navigation?: DocumentNavigationNode[];
}

export interface CollectedDocumentPage extends DocumentPageManifest {
	noteName: string;
	content: string;
	body?: string;
}

export interface DocumentBundleNote {
	path: string;
	content: string;
	sourceUrl?: string;
	pageId?: string;
}

export interface DocumentBundleOutput {
	title: string;
	folderPath: string;
	notes: DocumentBundleNote[];
	indexContent: string;
	mergedNoteName: string;
	mergedContent: string;
}

export interface FetchTextResult {
	ok: boolean;
	status: number;
	text: string;
	finalUrl?: string;
	error?: string;
}

export type FetchText = (url: string) => Promise<FetchTextResult>;

export function isLikelySphinxDocumentationHtml(html: string): boolean {
	if (!html) return false;
	const hasSphinxRoot = /\bdata-(?:content|url)_root\s*=/i.test(html);
	if (hasSphinxRoot) return true;
	const hasDocumentationOptions = /(?:^|[/"'])_static\/documentation_options\.js(?:[?"']|$)/i.test(html);
	const hasSphinxRuntime = /(?:^|[/"'])_static\/(?:doctools|sphinx_highlight)\.js(?:[?"']|$)/i.test(html);
	return hasDocumentationOptions && hasSphinxRuntime;
}

export function detectDocumentSourceKind(
	currentUrl: string,
	html: string
): DocumentSourceKind | null {
	let url: URL;
	try {
		url = new URL(currentUrl);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (isLikelySphinxDocumentationHtml(html)) return 'sphinx';
	if (
		url.hostname === 'platform.claude.com' &&
		/^\/docs\/[^/]+(?:\/|$)/.test(url.pathname)
	) return 'llms-txt';
	if (
		url.hostname === 'ai.google.dev' &&
		(url.pathname === '/gemini-api/docs' || url.pathname.startsWith('/gemini-api/docs/'))
	) return 'google-devsite';
	if (
		/(?:href=["'][^"']*llms\.txt|Fetch the complete documentation index at:[\s\S]{0,200}llms\.txt)/i.test(html)
	) return 'llms-txt-generic';
	if (/Docusaurus(?:\s+v[\d.]+)?/i.test(html) || /id=["']__docusaurus["']/i.test(html)) {
		return 'docusaurus';
	}
	return null;
}

function stableCollectionId(
	kind: DocumentSourceKind,
	rootUrl: string,
	locale: string
): string {
	const input = `${kind}\n${rootUrl}\n${locale}`;
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${kind}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function decodeXmlText(value: string): string {
	return value
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'");
}

function decodedPathTitle(path: string, fallback: string): string {
	const segment = path.split('/').filter(Boolean).pop() || fallback;
	try {
		return decodeURIComponent(segment)
			.replace(/[-_]+/g, ' ')
			.replace(/\b\w/g, character => character.toUpperCase());
	} catch {
		return segment.replace(/[-_]+/g, ' ');
	}
}

export interface LlmsTxtIndex {
	title: string;
	links: Array<{ title: string; url: string }>;
}

export function parseLlmsTxt(source: string): LlmsTxtIndex {
	const titleMatch = source.match(/^#\s+(.+?)\s*$/m);
	const links: LlmsTxtIndex['links'] = [];
	const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(source)) !== null) {
		links.push({ title: match[1].trim(), url: decodeXmlText(match[2]) });
	}
	if (links.length === 0) throw new Error('llms.txt contains no documentation links');
	return {
		title: titleMatch?.[1]?.trim() || 'Documentation',
		links,
	};
}

export function buildLlmsTxtManifest(
	currentUrl: string,
	index: LlmsTxtIndex
): DocumentManifest {
	const current = new URL(currentUrl);
	const localeMatch = current.pathname.match(/^\/docs\/([^/]+)(?:\/|$)/);
	if (!localeMatch) throw new Error('Claude documentation locale could not be determined');
	const locale = localeMatch[1];
	const root = new URL(`/docs/${locale}/`, current.origin);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const link of index.links) {
		let markdownUrl: URL;
		try {
			markdownUrl = new URL(link.url);
		} catch {
			continue;
		}
		if (
			markdownUrl.origin !== root.origin ||
			!markdownUrl.pathname.startsWith(root.pathname) ||
			!markdownUrl.pathname.endsWith('.md')
		) continue;
		markdownUrl.search = '';
		markdownUrl.hash = '';
		const relative = markdownUrl.pathname.slice(root.pathname.length, -3);
		if (!isSafeDocname(relative) || seen.has(relative)) continue;
		seen.add(relative);
		const pageUrl = new URL(`${relative}`, root);
		pages.push({
			docname: relative,
			title: plainTitle(link.title, decodedPathTitle(relative, relative)),
			url: pageUrl.toString(),
			fetchUrl: markdownUrl.toString(),
			contentType: 'markdown',
		});
	}
	if (pages.length === 0) throw new Error('llms.txt contains no pages for the current language');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) {
		throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	}
	return {
		kind: 'llms-txt',
		title: index.title,
		rootUrl: root.toString(),
		locale,
		collectionId: stableCollectionId('llms-txt', root.toString(), locale),
		pages,
		navigation: fallbackNavigation(pages),
	};
}

export function buildGenericLlmsTxtManifest(
	currentUrl: string,
	currentHtml: string,
	index: LlmsTxtIndex
): DocumentManifest {
	const current = new URL(currentUrl);
	const locale = currentHtml.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] || 'und';
	const currentLocaleSegment = current.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i)?.[1]?.toLowerCase();
	const candidates: Array<{ link: LlmsTxtIndex['links'][number]; markdownUrl: URL }> = [];
	for (const link of index.links) {
		let markdownUrl: URL;
		try { markdownUrl = new URL(link.url); } catch { continue; }
		if (markdownUrl.origin !== current.origin || !markdownUrl.pathname.endsWith('.md')) continue;
		const linkLocaleSegment = markdownUrl.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i)?.[1]?.toLowerCase();
		if (currentLocaleSegment && linkLocaleSegment && linkLocaleSegment !== currentLocaleSegment) continue;
		markdownUrl.search = '';
		markdownUrl.hash = '';
		candidates.push({ link, markdownUrl });
	}
	const commonSegments = candidates[0]?.markdownUrl.pathname.split('/').filter(Boolean).slice(0, -1) || [];
	for (const candidate of candidates.slice(1)) {
		const segments = candidate.markdownUrl.pathname.split('/').filter(Boolean).slice(0, -1);
		while (commonSegments.length > 0 && commonSegments.some((segment, index) => segments[index] !== segment)) {
			commonSegments.pop();
		}
	}
	const root = new URL(`/${commonSegments.join('/')}${commonSegments.length ? '/' : ''}`, current.origin);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const { link, markdownUrl } of candidates) {
		const relative = markdownUrl.pathname.slice(root.pathname.length, -3);
		if (!isSafeDocname(relative) || seen.has(relative)) continue;
		seen.add(relative);
		pages.push({
			docname: relative,
			title: plainTitle(link.title, decodedPathTitle(relative, relative)),
			url: new URL(relative, root).toString(),
			fetchUrl: markdownUrl.toString(),
			contentType: 'markdown',
		});
	}
	if (pages.length === 0) throw new Error('llms.txt contains no pages under the current documentation root');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	return {
		kind: 'llms-txt-generic', title: index.title, rootUrl: root.toString(), locale,
		collectionId: stableCollectionId('llms-txt-generic', root.toString(), locale),
		pages, navigation: fallbackNavigation(pages),
	};
}

export function parseSitemapLocations(source: string): string[] {
	const locations: string[] = [];
	const pattern = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source)) !== null) {
		const value = decodeXmlText(match[1].trim());
		if (/^https?:\/\//i.test(value)) locations.push(value);
	}
	return locations;
}

export function buildClaudeSitemapManifest(
	currentUrl: string,
	locations: string[],
	title = 'Anthropic Developer Documentation'
): DocumentManifest {
	const current = new URL(currentUrl);
	const localeMatch = current.pathname.match(/^\/docs\/([^/]+)(?:\/|$)/);
	if (!localeMatch) throw new Error('Claude documentation locale could not be determined');
	const locale = localeMatch[1];
	const root = new URL(`/docs/${locale}/`, current.origin);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const rawLocation of locations) {
		let location: URL;
		try { location = new URL(rawLocation); } catch { continue; }
		location.hash = '';
		location.search = '';
		if (location.origin !== root.origin || !location.pathname.startsWith(root.pathname)) continue;
		const relative = location.pathname.slice(root.pathname.length).replace(/\/$/, '') || 'index';
		if (!isSafeDocname(relative) || seen.has(relative)) continue;
		seen.add(relative);
		pages.push({
			docname: relative,
			title: decodedPathTitle(relative, relative),
			url: location.toString(),
			contentType: 'html',
		});
	}
	if (pages.length === 0) throw new Error('Claude sitemap contains no pages for the current language');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	pages.sort((left, right) => left.docname === 'index' ? -1 : right.docname === 'index' ? 1 : left.docname.localeCompare(right.docname));
	const localizedTitle = locale.toLowerCase() === 'en' ? title : `${title} - ${locale}`;
	return {
		kind: 'llms-txt', title: localizedTitle, rootUrl: root.toString(), locale,
		collectionId: stableCollectionId('llms-txt', root.toString(), locale),
		pages, navigation: fallbackNavigation(pages),
	};
}

export function buildDocusaurusManifest(
	currentUrl: string,
	currentHtml: string,
	locations: string[]
): DocumentManifest {
	const current = new URL(currentUrl);
	const htmlLocale = currentHtml.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1];
	const pathLocale = current.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i)?.[1];
	const locale = (htmlLocale || pathLocale || 'en').toLowerCase();
	const localePrefix = locale === 'en' ? '' : `/${pathLocale || locale}`;
	const root = new URL(`${localePrefix || ''}/`, current.origin);
	const titleFromHtml = currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation';
	const baseTitle = plainTitle(titleFromHtml.replace(/\s*[|–—-]\s*[^|–—]+$/, ''), 'Documentation');
	const title = locale === 'en' ? baseTitle : `${baseTitle} - ${locale}`;
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const rawLocation of locations) {
		let canonical: URL;
		try { canonical = new URL(rawLocation); } catch { continue; }
		canonical.hash = '';
		canonical.search = '';
		if (canonical.origin !== current.origin) continue;
		let relative = canonical.pathname.replace(/^\/+|\/+$/g, '') || 'index';
		if (localePrefix && relative.startsWith(`${localePrefix.slice(1)}/`)) {
			relative = relative.slice(localePrefix.length).replace(/^\/+/, '') || 'index';
		}
		if (!isSafeDocname(relative) || seen.has(relative)) continue;
		seen.add(relative);
		const localizedPath = relative === 'index'
			? `${localePrefix || ''}/`
			: `${localePrefix || ''}/${relative}`;
		const pageUrl = new URL(localizedPath, current.origin).toString();
		pages.push({ docname: relative, title: decodedPathTitle(relative, relative), url: pageUrl, contentType: 'html' });
	}
	if (pages.length === 0) throw new Error('Docusaurus sitemap contains no documentation pages');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	pages.sort((left, right) => left.docname === 'index' ? -1 : right.docname === 'index' ? 1 : left.docname.localeCompare(right.docname));
	return {
		kind: 'docusaurus', title, rootUrl: root.toString(), locale,
		collectionId: stableCollectionId('docusaurus', root.toString(), locale),
		pages, navigation: fallbackNavigation(pages),
	};
}

export function buildGoogleDevsiteManifest(
	currentUrl: string,
	locations: string[]
): DocumentManifest {
	const current = new URL(currentUrl);
	const locale = current.searchParams.get('hl') || 'en';
	const root = new URL('/gemini-api/docs/', current.origin);
	const rootWithoutSlash = root.pathname.replace(/\/$/, '');
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const rawLocation of locations) {
		let location: URL;
		try {
			location = new URL(rawLocation);
		} catch {
			continue;
		}
		location.hash = '';
		location.search = '';
		if (
			location.origin !== root.origin ||
			(location.pathname !== rootWithoutSlash && !location.pathname.startsWith(root.pathname))
		) continue;
		const canonical = location.toString();
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		const relative = location.pathname === rootWithoutSlash
			? 'index'
			: location.pathname.slice(root.pathname.length).replace(/\/$/, '') || 'index';
		if (!isSafeDocname(relative)) continue;
		const fetchUrl = new URL(canonical);
		if (locale !== 'en') fetchUrl.searchParams.set('hl', locale);
		pages.push({
			docname: relative,
			title: relative === 'index'
				? 'Gemini API documentation'
				: decodedPathTitle(relative, relative),
			url: canonical,
			fetchUrl: fetchUrl.toString(),
			contentType: 'html',
		});
	}
	if (pages.length === 0) throw new Error('Gemini sitemap contains no documentation pages');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) {
		throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	}
	pages.sort((left, right) => {
		if (left.docname === 'index') return -1;
		if (right.docname === 'index') return 1;
		return left.docname.localeCompare(right.docname);
	});
	return {
		kind: 'google-devsite',
		title: locale === 'en' ? 'Gemini API documentation' : `Gemini API documentation - ${locale}`,
		rootUrl: root.toString(),
		locale,
		collectionId: stableCollectionId('google-devsite', root.toString(), locale),
		pages,
		navigation: fallbackNavigation(pages),
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function parseSphinxSearchIndex(source: string): SphinxSearchIndex {
	const raw = source.trim();
	const trimmed = raw.endsWith(';') ? raw.slice(0, -1).trimEnd() : raw;
	const prefix = 'Search.setIndex(';
	if (!trimmed.startsWith(prefix) || !trimmed.endsWith(')')) {
		throw new Error('Response is not a Sphinx search index');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed.slice(prefix.length, -1));
	} catch {
		throw new Error('Sphinx search index contains invalid JSON');
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Sphinx search index is missing document metadata');
	}
	const record = parsed as Record<string, unknown>;
	if (!isStringArray(record.docnames) || !isStringArray(record.titles)) {
		throw new Error('Sphinx search index is missing document names or titles');
	}
	if (record.docnames.length !== record.titles.length) {
		throw new Error('Sphinx search index document metadata is inconsistent');
	}
	return { docnames: record.docnames, titles: record.titles };
}

function validateRootUrl(rawRootUrl: string): URL {
	const root = new URL(rawRootUrl);
	if (root.protocol !== 'http:' && root.protocol !== 'https:') {
		throw new Error('Documentation root must use HTTP or HTTPS');
	}
	root.search = '';
	root.hash = '';
	if (!root.pathname.endsWith('/')) {
		root.pathname = `${root.pathname}/`;
	}
	return root;
}

function isSafeDocname(docname: string): boolean {
	return Boolean(docname) &&
		docname.length <= 500 &&
		!docname.startsWith('/') &&
		!docname.startsWith('.') &&
		!docname.endsWith('/') &&
		!docname.includes('\\') &&
		!docname.includes('?') &&
		!docname.includes('#') &&
		!docname.split('/').some(segment => !segment || segment === '.' || segment === '..') &&
		/^[\p{L}\p{N}_./-]+$/u.test(docname);
}

function plainTitle(title: string, fallback: string): string {
	const text = title
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
	return text || fallback;
}

export function buildSphinxManifest(
	rawRootUrl: string,
	index: SphinxSearchIndex
): DocumentManifest {
	const root = validateRootUrl(rawRootUrl);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();

	for (let indexPosition = 0; indexPosition < index.docnames.length; indexPosition += 1) {
		const docname = index.docnames[indexPosition];
		if (!isSafeDocname(docname)) {
			throw new Error(`Unsafe Sphinx document name: ${docname}`);
		}
		if (GENERATED_SPHINX_DOCS.has(docname) || seen.has(docname)) continue;
		seen.add(docname);
		const pageUrl = new URL(`${docname}.html`, root);
		if (pageUrl.origin !== root.origin || !pageUrl.pathname.startsWith(root.pathname)) {
			throw new Error(`Unsafe Sphinx document URL: ${docname}`);
		}
		pages.push({
			docname,
			title: plainTitle(index.titles[indexPosition], docname.split('/').pop() || docname),
			url: pageUrl.toString(),
		});
	}

	if (pages.length === 0) throw new Error('Sphinx search index contains no pages');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) {
		throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	}
	const indexPage = pages.find(page => page.docname === 'index') || pages[0];
	return {
		kind: 'sphinx',
		title: indexPage.title,
		rootUrl: root.toString(),
		pages,
	};
}

function candidateSphinxRoots(currentUrl: string): URL[] {
	const current = new URL(currentUrl);
	if (current.protocol !== 'http:' && current.protocol !== 'https:') return [];
	current.search = '';
	current.hash = '';
	if (!current.pathname.endsWith('/')) {
		current.pathname = current.pathname.slice(0, current.pathname.lastIndexOf('/') + 1);
	}
	const roots: URL[] = [];
	for (let depth = 0; depth < 6; depth += 1) {
		roots.push(new URL(current.toString()));
		if (current.pathname === '/') break;
		const withoutSlash = current.pathname.replace(/\/$/, '');
		current.pathname = withoutSlash.slice(0, withoutSlash.lastIndexOf('/') + 1) || '/';
	}
	return roots;
}

const SPHINX_NAVIGATION_SELECTORS = [
	'.sphinxsidebarwrapper',
	'.wy-menu-vertical',
	'.sidebar-tree',
	'nav[aria-label="Main navigation"]',
	'nav[aria-label="Primary"]',
	'.bd-docs-nav',
	'.toctree-wrapper',
];

function canonicalDocumentUrl(rawUrl: string, baseUrl: string): string | null {
	try {
		const url = new URL(rawUrl, baseUrl);
		url.search = '';
		url.hash = '';
		if (url.pathname.endsWith('/')) url.pathname += 'index.html';
		return url.toString();
	} catch {
		return null;
	}
}

function fallbackNavigation(pages: DocumentPageManifest[]): DocumentNavigationNode[] {
	const roots: DocumentNavigationNode[] = [];
	const groupKey = (parentKey: string, segment: string) => `${parentKey}/${segment}`;
	const groups = new Map<string, DocumentNavigationNode>();

	for (const page of pages) {
		const segments = page.docname.split('/');
		segments.pop();
		let siblings = roots;
		let parentKey = '';
		for (const segment of segments) {
			const key = groupKey(parentKey, segment);
			let group = groups.get(key);
			if (!group) {
				group = { title: segment, children: [] };
				groups.set(key, group);
				siblings.push(group);
			}
			siblings = group.children;
			parentKey = key;
		}
		siblings.push({ docname: page.docname, title: page.title, children: [] });
	}
	return roots;
}

function directLists(element: Element): Element[] {
	return Array.from(element.querySelectorAll('ul')).filter(list => {
		const ancestorList = list.parentElement?.closest('ul');
		return !ancestorList || !element.contains(ancestorList);
	});
}

function navigationCaption(list: Element): string | null {
	let sibling = list.previousElementSibling;
	while (sibling) {
		if (sibling.matches('.caption, p.caption')) {
			return plainTitle(sibling.textContent || '', 'Section');
		}
		if (sibling.tagName.toLowerCase() === 'ul') break;
		sibling = sibling.previousElementSibling;
	}
	return null;
}

function appendMissingNavigationPages(
	tree: DocumentNavigationNode[],
	missingPages: DocumentPageManifest[],
	locale?: string
): void {
	const indexPage = missingPages.find(page => page.docname === 'index');
	if (indexPage) {
		tree.unshift({ docname: indexPage.docname, title: indexPage.title, children: [] });
	}
	const remaining = missingPages.filter(page => page !== indexPage);
	if (remaining.length > 0) {
		const children = fallbackNavigation(remaining);
		localizeFallbackGroupTitles(children, locale);
		tree.push({ title: otherPagesTitle(locale), children });
	}
}

function isChineseDocumentationLocale(locale?: string): boolean {
	return /^zh(?:-|$)/i.test(locale || '');
}

function otherPagesTitle(locale?: string): string {
	return isChineseDocumentationLocale(locale) ? '其他页面' : 'Other pages';
}

function localizeFallbackGroupTitles(nodes: DocumentNavigationNode[], locale?: string): void {
	if (!isChineseDocumentationLocale(locale)) return;
	const titles: Record<string, string> = {
		models: '模型详情',
		'generate-content': 'Generate Content API（旧版）',
	};
	for (const node of nodes) {
		if (!node.docname) node.title = titles[node.title.toLocaleLowerCase()] || node.title;
		localizeFallbackGroupTitles(node.children, locale);
	}
}

function ownListAnchor(item: Element): HTMLAnchorElement | null {
	return Array.from(item.querySelectorAll('a[href]')).find(anchor =>
		anchor.closest('li') === item
	) as HTMLAnchorElement | undefined || null;
}

function childLists(item: Element): Element[] {
	return Array.from(item.querySelectorAll('ul')).filter(list => {
		if (list.closest('li') !== item) return false;
		const ancestorList = list.parentElement?.closest('ul');
		return !ancestorList || ancestorList.closest('li') !== item;
	});
}

function ownNavigationLabel(item: Element): string {
	const collect = (node: Node): string[] => {
		if (node.nodeType === 3) return [node.textContent || ''];
		const element = node as Element;
		if (!element.tagName || /^(?:ul|ol|a)$/i.test(element.tagName)) return [];
		return Array.from(element.childNodes).flatMap(collect);
	};
	const text = Array.from(item.childNodes).flatMap(collect).join(' ');
	return plainTitle(text, '');
}

function countNavigationPages(nodes: DocumentNavigationNode[]): number {
	return nodes.reduce(
		(total, node) => total + (node.docname ? 1 : 0) + countNavigationPages(node.children),
		0
	);
}

export function parseSphinxNavigation(options: {
	html: string;
	pageUrl: string;
	manifest: DocumentManifest;
	documentParser: DocumentParser;
}): DocumentNavigationNode[] {
	const document = options.documentParser.parseFromString(options.html, 'text/html') as Document;
	const root = new URL(options.manifest.rootUrl);
	const pageByUrl = new Map<string, DocumentPageManifest>();
	for (const page of options.manifest.pages) {
		const canonical = canonicalDocumentUrl(page.url, options.manifest.rootUrl);
		if (canonical) pageByUrl.set(canonical, page);
	}

	const containers: Element[] = [];
	const seenContainers = new Set<Element>();
	for (const selector of SPHINX_NAVIGATION_SELECTORS) {
		for (const container of Array.from(document.querySelectorAll(selector))) {
			if (seenContainers.has(container)) continue;
			seenContainers.add(container);
			containers.push(container);
		}
	}

	let bestTree: DocumentNavigationNode[] = [];
	for (const container of containers) {
		const seenPages = new Set<string>();
		const parseList = (list: Element): DocumentNavigationNode[] => {
			const nodes: DocumentNavigationNode[] = [];
			for (const item of Array.from(list.children).filter(child => child.tagName.toLowerCase() === 'li')) {
				const nested = childLists(item).flatMap(parseList);
				const anchor = ownListAnchor(item);
				if (!anchor) {
					nodes.push(...nested);
					continue;
				}
				const canonical = canonicalDocumentUrl(anchor.getAttribute('href') || '', options.pageUrl);
				if (!canonical) {
					nodes.push(...nested);
					continue;
				}
				const target = new URL(canonical);
				if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) {
					nodes.push(...nested);
					continue;
				}
				const page = pageByUrl.get(canonical);
				if (!page || seenPages.has(page.docname)) {
					nodes.push(...nested);
					continue;
				}
				seenPages.add(page.docname);
				nodes.push({
					docname: page.docname,
					title: plainTitle(anchor.textContent || '', page.title),
					children: nested,
				});
			}
			return nodes;
		};
		const tree = directLists(container).flatMap(list => {
			const nodes = parseList(list);
			const caption = navigationCaption(list);
			return caption && nodes.length > 0
				? [{ title: caption, children: nodes }]
				: nodes;
		});
		if (countNavigationPages(tree) > countNavigationPages(bestTree)) bestTree = tree;
	}

	if (bestTree.length === 0) return fallbackNavigation(options.manifest.pages);
	const included = new Set<string>();
	const collectIncluded = (nodes: DocumentNavigationNode[]) => {
		for (const node of nodes) {
			if (node.docname) included.add(node.docname);
			collectIncluded(node.children);
		}
	};
	collectIncluded(bestTree);
	const missing = options.manifest.pages.filter(page => !included.has(page.docname));
	appendMissingNavigationPages(bestTree, missing, options.manifest.locale);
	return bestTree;
}

const DOCUMENTATION_NAVIGATION_SELECTORS = [
	'nav[aria-label="Pages"]',
	'nav[aria-label="侧边菜单"]',
	'nav[aria-label="Docs sidebar"]',
	'.theme-doc-sidebar-container',
	'[data-testid*="sidebar"]',
	'aside nav',
];

function normalizedNavigationUrl(rawUrl: string, baseUrl: string): string | null {
	try {
		const url = new URL(rawUrl, baseUrl);
		url.search = '';
		url.hash = '';
		url.pathname = url.pathname.replace(/\/+$/, '') || '/';
		return url.toString();
	} catch {
		return null;
	}
}

export function parseDocumentationNavigation(options: {
	html: string;
	pageUrl: string;
	manifest: DocumentManifest;
	documentParser: DocumentParser;
}): DocumentNavigationNode[] {
	const document = options.documentParser.parseFromString(options.html, 'text/html') as Document;
	const root = new URL(options.manifest.rootUrl);
	const pageByUrl = new Map<string, DocumentPageManifest>();
	for (const page of options.manifest.pages) {
		const key = normalizedNavigationUrl(page.url, options.manifest.rootUrl);
		if (key) pageByUrl.set(key, page);
	}

	let bestTree: DocumentNavigationNode[] = [];
	const seenContainers = new Set<Element>();
	for (const selector of DOCUMENTATION_NAVIGATION_SELECTORS) {
		for (const container of Array.from(document.querySelectorAll(selector))) {
			if (seenContainers.has(container)) continue;
			seenContainers.add(container);
			const seenPages = new Set<string>();
			const parseList = (list: Element): DocumentNavigationNode[] => {
				const nodes: DocumentNavigationNode[] = [];
				for (const item of Array.from(list.children).filter(child => child.tagName.toLowerCase() === 'li')) {
					const nested = childLists(item).flatMap(parseList);
					const anchor = ownListAnchor(item);
					if (!anchor) {
						const label = ownNavigationLabel(item);
						if (label && nested.length > 0) nodes.push({ title: label, children: nested });
						else nodes.push(...nested);
						continue;
					}
					const key = normalizedNavigationUrl(anchor.getAttribute('href') || '', options.pageUrl);
					if (!key) {
						nodes.push(...nested);
						continue;
					}
					const target = new URL(key);
					const page = target.origin === root.origin ? pageByUrl.get(key) : undefined;
					if (!page || seenPages.has(page.docname)) {
						nodes.push(...nested);
						continue;
					}
					seenPages.add(page.docname);
					nodes.push({
						docname: page.docname,
						title: plainTitle(anchor.textContent || '', page.title),
						children: nested,
					});
				}
				return nodes;
			};
			const tree = directLists(container).flatMap(parseList);
			if (countNavigationPages(tree) > countNavigationPages(bestTree)) bestTree = tree;
		}
	}
	if (bestTree.length === 0) return [];
	const included = new Set<string>();
	const collect = (nodes: DocumentNavigationNode[]) => nodes.forEach(node => {
		if (node.docname) included.add(node.docname);
		collect(node.children);
	});
	collect(bestTree);
	appendMissingNavigationPages(
		bestTree,
		options.manifest.pages.filter(page => !included.has(page.docname)),
		options.manifest.locale
	);
	return bestTree;
}

export async function discoverSphinxDocumentation(
	currentUrl: string,
	fetchText: FetchText,
	documentParser?: DocumentParser
): Promise<DocumentManifest> {
	let lastError: Error | null = null;
	for (const root of candidateSphinxRoots(currentUrl)) {
		const indexUrl = new URL('searchindex.js', root).toString();
		const response = await fetchText(indexUrl);
		if (!response.ok) continue;
		try {
			const parsed = parseSphinxSearchIndex(response.text);
			const finalIndexUrl = new URL(response.finalUrl || indexUrl);
			if (finalIndexUrl.origin !== root.origin) {
				throw new Error('Sphinx search index redirected to another origin');
			}
			const manifest = buildSphinxManifest(new URL('./', finalIndexUrl).toString(), parsed);
			if (documentParser) {
				const navigationPage = manifest.pages.find(page => page.docname === 'index') || manifest.pages[0];
				const navigationResponse = await fetchText(navigationPage.url);
				if (navigationResponse.ok) {
					const finalNavigationUrl = new URL(navigationResponse.finalUrl || navigationPage.url);
					const navigationRoot = new URL(manifest.rootUrl);
					if (
						finalNavigationUrl.origin === navigationRoot.origin &&
						finalNavigationUrl.pathname.startsWith(navigationRoot.pathname)
					) {
						manifest.navigation = parseSphinxNavigation({
							html: navigationResponse.text,
							pageUrl: finalNavigationUrl.toString(),
							manifest,
							documentParser,
						});
					}
				}
			}
			return manifest;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastError || new Error('No Sphinx documentation index was found');
}

export interface DocumentSourceAdapter {
	kind: DocumentSourceKind;
	matches(currentUrl: string, currentHtml: string): boolean;
	discover(options: {
		currentUrl: string;
		currentHtml: string;
		fetchText: FetchText;
		documentParser?: DocumentParser;
	}): Promise<DocumentManifest>;
}

async function discoverLlmsTxtDocumentation(options: {
	currentUrl: string;
	fetchText: FetchText;
}): Promise<DocumentManifest> {
	const current = new URL(options.currentUrl);
	const indexUrl = new URL('/llms.txt', current.origin).toString();
	const response = await options.fetchText(indexUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch llms.txt (${response.status || response.error || 'network error'})`);
	}
	const finalUrl = new URL(response.finalUrl || indexUrl);
	if (finalUrl.origin !== current.origin) {
		throw new Error('llms.txt redirected to another origin');
	}
	const index = parseLlmsTxt(response.text);
	try {
		return buildLlmsTxtManifest(options.currentUrl, index);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes('current language')) throw error;
		const sitemapUrl = new URL('/sitemap.xml', current.origin).toString();
		const sitemap = await options.fetchText(sitemapUrl);
		if (!sitemap.ok) throw error;
		return buildClaudeSitemapManifest(options.currentUrl, parseSitemapLocations(sitemap.text), index.title);
	}
}

async function discoverDocusaurusDocumentation(options: {
	currentUrl: string;
	currentHtml: string;
	fetchText: FetchText;
}): Promise<DocumentManifest> {
	const current = new URL(options.currentUrl);
	const sitemapUrl = new URL('/sitemap.xml', current.origin).toString();
	const response = await options.fetchText(sitemapUrl);
	if (!response.ok) throw new Error(`Failed to fetch sitemap (${response.status || response.error || 'network error'})`);
	const finalUrl = new URL(response.finalUrl || sitemapUrl);
	if (finalUrl.origin !== current.origin) throw new Error('Sitemap redirected to another origin');
	return buildDocusaurusManifest(options.currentUrl, options.currentHtml, parseSitemapLocations(response.text));
}

async function discoverGenericLlmsTxtDocumentation(options: {
	currentUrl: string;
	currentHtml: string;
	fetchText: FetchText;
}): Promise<DocumentManifest> {
	const hrefMatch = options.currentHtml.match(/href=["']([^"']*llms\.txt)["']/i)?.[1];
	const textMatch = options.currentHtml.match(/(?:documentation index at:|文档索引[^\s<:]*(?:位于|：|:)?)[\s\S]{0,120}?([^\s"'<>]*llms\.txt)/i)?.[1];
	const indexUrl = new URL(hrefMatch || textMatch || 'llms.txt', options.currentUrl).toString();
	const response = await options.fetchText(indexUrl);
	if (!response.ok) throw new Error(`Failed to fetch llms.txt (${response.status || response.error || 'network error'})`);
	const finalUrl = new URL(response.finalUrl || indexUrl);
	if (finalUrl.origin !== new URL(options.currentUrl).origin) throw new Error('llms.txt redirected to another origin');
	return buildGenericLlmsTxtManifest(options.currentUrl, options.currentHtml, parseLlmsTxt(response.text));
}

async function discoverGoogleDevsiteDocumentation(options: {
	currentUrl: string;
	fetchText: FetchText;
}): Promise<DocumentManifest> {
	const current = new URL(options.currentUrl);
	const sitemapUrl = new URL('/sitemap.xml', current.origin).toString();
	const response = await options.fetchText(sitemapUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch sitemap (${response.status || response.error || 'network error'})`);
	}
	const finalUrl = new URL(response.finalUrl || sitemapUrl);
	if (finalUrl.origin !== current.origin) {
		throw new Error('Sitemap redirected to another origin');
	}
	const rootLocations = parseSitemapLocations(response.text);
	const shardUrls = rootLocations.filter(location => {
		try {
			const url = new URL(location);
			return url.origin === current.origin && url.pathname.endsWith('.xml');
		} catch {
			return false;
		}
	});
	if (shardUrls.length > 32) throw new Error('Sitemap contains too many shards');
	let pageLocations = rootLocations.filter(location => !location.endsWith('.xml'));
	if (shardUrls.length > 0) {
		const shardResults = await Promise.all(shardUrls.map(async shardUrl => {
			const shard = await options.fetchText(shardUrl);
			if (!shard.ok) {
				throw new Error(`Failed to fetch sitemap shard (${shard.status || shard.error || 'network error'})`);
			}
			const finalShardUrl = new URL(shard.finalUrl || shardUrl);
			if (finalShardUrl.origin !== current.origin) {
				throw new Error('Sitemap shard redirected to another origin');
			}
			return parseSitemapLocations(shard.text);
		}));
		pageLocations = shardResults.flat();
	}
	return buildGoogleDevsiteManifest(options.currentUrl, pageLocations);
}

export const DOCUMENT_SOURCE_ADAPTERS: DocumentSourceAdapter[] = [
	{
		kind: 'sphinx',
		matches: (currentUrl, currentHtml) =>
			detectDocumentSourceKind(currentUrl, currentHtml) === 'sphinx',
		discover: options => discoverSphinxDocumentation(
			options.currentUrl,
			options.fetchText,
			options.documentParser
		),
	},
	{
		kind: 'llms-txt',
		matches: (currentUrl, currentHtml) =>
			detectDocumentSourceKind(currentUrl, currentHtml) === 'llms-txt',
		discover: options => discoverLlmsTxtDocumentation(options),
	},
	{
		kind: 'google-devsite',
		matches: (currentUrl, currentHtml) =>
			detectDocumentSourceKind(currentUrl, currentHtml) === 'google-devsite',
		discover: options => discoverGoogleDevsiteDocumentation(options),
	},
	{
		kind: 'docusaurus',
		matches: (currentUrl, currentHtml) => detectDocumentSourceKind(currentUrl, currentHtml) === 'docusaurus',
		discover: options => discoverDocusaurusDocumentation(options),
	},
	{
		kind: 'llms-txt-generic',
		matches: (currentUrl, currentHtml) => detectDocumentSourceKind(currentUrl, currentHtml) === 'llms-txt-generic',
		discover: options => discoverGenericLlmsTxtDocumentation(options),
	},
];

export async function discoverDocumentation(options: {
	currentUrl: string;
	currentHtml: string;
	fetchText: FetchText;
	documentParser?: DocumentParser;
}): Promise<DocumentManifest> {
	const adapter = DOCUMENT_SOURCE_ADAPTERS.find(candidate =>
		candidate.matches(options.currentUrl, options.currentHtml)
	);
	if (!adapter) throw new Error('No supported documentation source was found');
	const manifest = await adapter.discover(options);
	if (options.documentParser && options.currentHtml) {
		const navigation = parseDocumentationNavigation({
			html: options.currentHtml,
			pageUrl: options.currentUrl,
			manifest,
			documentParser: options.documentParser,
		});
		if (countNavigationPages(navigation) > 0) manifest.navigation = navigation;
	}
	if (!manifest.collectionId) {
		const locale = manifest.locale || 'und';
		manifest.collectionId = stableCollectionId(manifest.kind, manifest.rootUrl, locale);
		manifest.locale = locale;
	}
	return manifest;
}

export async function collectDocumentPages(options: {
	manifest: DocumentManifest;
	pages?: DocumentPageManifest[];
	template: Template;
	propertyTypes?: Record<string, string>;
	documentParser: DocumentParser;
	fetchText: FetchText;
	concurrency?: number;
	onProgress?: (completed: number, total: number, page: DocumentPageManifest) => void;
	seenSourceUrls?: Set<string>;
}): Promise<CollectedDocumentPage[]> {
	const sourcePages = options.pages || options.manifest.pages;
	const results = new Array<CollectedDocumentPage | undefined>(sourcePages.length);
	const concurrency = Math.max(
		1,
		Math.min(options.concurrency || DOCUMENT_BUNDLE_FETCH_CONCURRENCY, 6)
	);
	let nextIndex = 0;
	let completed = 0;
	const root = new URL(options.manifest.rootUrl);
	const rootPath = root.pathname.replace(/\/+$/, '') || '/';

	const worker = async () => {
		while (true) {
			const pageIndex = nextIndex;
			nextIndex += 1;
			if (pageIndex >= sourcePages.length) return;
			const page = sourcePages[pageIndex];
			const requestUrl = page.fetchUrl || page.url;
			const response = await options.fetchText(requestUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch ${page.title} (${response.status || response.error || 'network error'})`);
			}
			const finalUrl = new URL(response.finalUrl || requestUrl);
			const finalPath = finalUrl.pathname.replace(/\/+$/, '') || '/';
			if (
				finalUrl.origin !== root.origin ||
				(finalPath !== rootPath && !finalUrl.pathname.startsWith(root.pathname))
			) {
				throw new Error(`Documentation page redirected outside its root: ${requestUrl}`);
			}
			const sourceUrl = page.contentType === 'markdown' ? page.url : finalUrl.toString();
			const preparedSource = page.contentType === 'markdown'
				? normalizeDocumentationMarkdown(response.text, sourceUrl)
				: preserveDocumentationCardGrids(response.text, sourceUrl, options.documentParser);
			const result = page.contentType === 'markdown'
				? await clipMarkdown({
					markdown: preparedSource,
					title: page.title,
					url: sourceUrl,
					template: options.template,
					language: options.manifest.locale,
					propertyTypes: options.propertyTypes,
				})
				: await clip({
					html: preparedSource,
					url: sourceUrl,
					template: options.template,
					documentParser: options.documentParser,
					propertyTypes: options.propertyTypes,
				});
			const sourceKey = normalizedSourceUrl(sourceUrl);
			const isDuplicate = options.seenSourceUrls?.has(sourceKey) || false;
			if (!isDuplicate) options.seenSourceUrls?.add(sourceKey);
			const titleVariable = result.variables['{{title}}'];
			const pageTitle = normalizedDocumentPageTitle(
				typeof titleVariable === 'string' ? titleVariable : result.noteName,
				page.title
			);
			if (!isDuplicate) results[pageIndex] = {
				...page,
				title: pageTitle,
				url: sourceUrl,
				noteName: pageTitle,
				content: normalizeDocumentNoteContent(result.fullContent, pageTitle),
				body: restoreDocumentationCardGrids(result.content),
			};
			completed += 1;
			options.onProgress?.(completed, sourcePages.length, page);
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(concurrency, sourcePages.length) },
			() => worker()
		)
	);
	return results.filter((page): page is CollectedDocumentPage => Boolean(page));
}

function normalizedSourceUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.hash = '';
	const entries = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
	url.search = '';
	for (const [key, value] of entries) url.searchParams.append(key, value);
	return url.toString();
}

function normalizedDocumentPageTitle(candidate: string, fallback: string): string {
	const cleaned = plainTitle(candidate.replace(/\u00a0/g, ' ').split(/\s+[|｜]\s+/)[0], fallback);
	return /^(?:Gemini API|DeepSeek API Docs|Documentation)$/i.test(cleaned)
		? plainTitle(fallback, cleaned)
		: cleaned;
}

function normalizeDocumentNoteContent(content: string, title: string): string {
	let normalized = restoreDocumentationCardGrids(content).replace(/\r\n?/g, '\n');
	if (!normalized.startsWith('---\n')) return normalized;
	const end = normalized.indexOf('\n---\n', 4);
	if (end < 0) return normalized;
	const frontmatter = normalized.slice(4, end).split('\n')
		.map(line => /^title:\s*/i.test(line) ? `title: ${JSON.stringify(title)}` : line)
		.filter(line => !/^(?:author|published|description):\s*$/i.test(line));
	return `---\n${frontmatter.join('\n')}\n---\n${normalized.slice(end + 5)}`;
}

const DOCUMENTATION_INDEX_NOTICE = /^\s*>\s*##\s*Documentation Index\s*\n(?:>[^\n]*\n){1,4}\s*/i;

export function normalizeDocumentationMarkdown(markdown: string, sourceUrl: string): string {
	const withoutNotice = markdown.replace(/\r\n?/g, '\n').replace(DOCUMENTATION_INDEX_NOTICE, '');
	let inFence = false;
	return withoutNotice.split('\n').map(line => {
		if (/^\s*(`{3,}|~{3,})/.test(line)) {
			inFence = !inFence;
			return line;
		}
		if (inFence) return line;
		return line.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (match, prefix, destination, suffix) => {
			if (!/^(?:\.\.?\/|\/)/.test(destination)) return match;
			try {
				return `${prefix}${new URL(destination, sourceUrl).toString()}${suffix}`;
			} catch {
				return match;
			}
		});
	}).join('\n').trim();
}

const DOCUMENT_CARD_TOKEN_PREFIX = 'OBSIDIANDOCUMENTCARDGRIDSTART';
const DOCUMENT_CARD_TOKEN_PAYLOAD = 'PAYLOAD';
const DOCUMENT_CARD_TOKEN_SUFFIX = 'OBSIDIANDOCUMENTCARDGRIDEND';

function htmlEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cardGridHtml(
	cards: Array<{ title: string; description: string; url: string }>,
	heading = ''
): string {
	const items = cards.map(card =>
		`<a href="${htmlEscape(card.url)}" style="display:block;border:1px solid #c7c7c7;border-radius:10px;padding:14px 16px;text-decoration:none;color:inherit;">` +
		`<strong>${htmlEscape(card.title)}</strong><br><span>${htmlEscape(card.description)}</span></a>`
	).join('');
	const title = heading ? `## ${heading}\n\n` : '';
	return `${title}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0;">${items}</div>`;
}

export function preserveDocumentationCardGrids(
	html: string,
	pageUrl: string,
	documentParser: DocumentParser
): string {
	const document = documentParser.parseFromString(html, 'text/html') as Document;
	const containers = Array.from(document.querySelectorAll(
		'.gemini-api-recommended, .gemini-api-explore, [class*="card-grid"], [data-card-grid]'
	));
	let tokenIndex = 0;
	for (const container of containers) {
		const headingElement = Array.from(container.querySelectorAll('h1, h2, h3, h4'))
			.find(candidate => !candidate.closest('a[href]'));
		const heading = plainTitle(headingElement?.textContent || '', '');
		const cards = Array.from(container.children).flatMap(child => {
			const anchor = child.matches('a[href]') ? child : child.querySelector('a[href]');
			if (!anchor) return [];
			const titleElement = anchor.querySelector(
				'.gemini-api-card-title, [class*="card-title"], h2, h3, h4, strong'
			);
			const descriptionElement = anchor.querySelector(
				'.gemini-api-card-description, [class*="card-description"]'
			);
			const title = plainTitle(titleElement?.textContent || '', '');
			const description = plainTitle(descriptionElement?.textContent || '', '');
			if (!title || !description) return [];
			try {
				const url = new URL(anchor.getAttribute('href') || '', pageUrl);
				if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
				return [{ title, description, url: url.toString() }];
			} catch {
				return [];
			}
		});
		if (cards.length < 2) continue;
		const payload = { heading, cards };
		const token = `${DOCUMENT_CARD_TOKEN_PREFIX}${tokenIndex}${DOCUMENT_CARD_TOKEN_PAYLOAD}` +
			`${encodeURIComponent(JSON.stringify(payload))}${DOCUMENT_CARD_TOKEN_SUFFIX}`;
		tokenIndex += 1;
		const placeholder = document.createElement('p');
		placeholder.textContent = token;
		container.replaceWith(placeholder);
	}
	return document.documentElement.outerHTML;
}

export function restoreDocumentationCardGrids(markdown: string): string {
	const restore = (match: string, encoded: string): string => {
		try {
			const decoded = JSON.parse(decodeURIComponent(encoded.replace(/\\_/g, '_'))) as
				Array<{ title: string; description: string; url: string }> | {
					heading?: string;
					cards: Array<{ title: string; description: string; url: string }>;
				};
			const cards = Array.isArray(decoded) ? decoded : decoded.cards;
			const heading = Array.isArray(decoded) ? '' : plainTitle(decoded.heading || '', '');
			if (!Array.isArray(cards) || cards.length === 0) return match;
			return `\n\n${cardGridHtml(cards as Array<{
				title: string; description: string; url: string;
			}>, heading)}\n\n`;
		} catch {
			return match;
		}
	};
	const currentPattern = new RegExp(
		`${DOCUMENT_CARD_TOKEN_PREFIX}\\d+${DOCUMENT_CARD_TOKEN_PAYLOAD}([^\\s]+?)${DOCUMENT_CARD_TOKEN_SUFFIX}`,
		'g'
	);
	const optionalEscape = '(?:\\\\)?_';
	const legacyPattern = new RegExp(
		`OBSIDIAN${optionalEscape}DOCUMENT${optionalEscape}CARD${optionalEscape}GRID${optionalEscape}` +
		`\\d+${optionalEscape}([^\\s]+?)${optionalEscape}END`,
		'g'
	);
	return markdown.replace(currentPattern, restore).replace(legacyPattern, restore);
}

function safePathSegment(value: string, fallback: string): string {
	return sanitizeFileName(value).replace(/[/.]+$/g, '').trim() || fallback;
}

function normalizeBasePath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
}

function completeNavigation(manifest: DocumentManifest): DocumentNavigationNode[] {
	if (!manifest.navigation?.length) return fallbackNavigation(manifest.pages);
	const pageNames = new Set(manifest.pages.map(page => page.docname));
	const seen = new Set<string>();
	const normalizeNodes = (nodes: DocumentNavigationNode[]): DocumentNavigationNode[] => {
		const normalized: DocumentNavigationNode[] = [];
		for (const node of nodes) {
			const children = normalizeNodes(node.children || []);
			if (node.docname && (!pageNames.has(node.docname) || seen.has(node.docname))) {
				normalized.push(...children);
				continue;
			}
			if (node.docname) seen.add(node.docname);
			if (node.docname || children.length > 0) {
				normalized.push({ title: node.title, docname: node.docname, children });
			}
		}
		return normalized;
	};
	const tree = normalizeNodes(manifest.navigation);
	const missing = manifest.pages.filter(page => !seen.has(page.docname));
	appendMissingNavigationPages(tree, missing, manifest.locale);
	return tree;
}

interface NavigationRecord {
	node: DocumentNavigationNode;
	page: CollectedDocumentPage;
	ancestors: DocumentNavigationNode[];
	depth: number;
}

function flattenNavigation(
	nodes: DocumentNavigationNode[],
	pageByDocname: Map<string, CollectedDocumentPage>,
	ancestors: DocumentNavigationNode[] = [],
	depth = 0
): NavigationRecord[] {
	const records: NavigationRecord[] = [];
	for (const node of nodes) {
		if (node.docname) {
			const page = pageByDocname.get(node.docname);
			if (page) records.push({ node, page, ancestors, depth });
		}
		records.push(...flattenNavigation(node.children, pageByDocname, [...ancestors, node], depth + 1));
	}
	return records;
}

function noteDirectory(
	folderPath: string,
	ancestors: DocumentNavigationNode[],
	manifestTitle: string
): string {
	const segments = ancestors
		.filter((node, index) => {
			if (node.docname === 'index' && index === 0) return false;
			return !(index === 0 && !node.docname && node.title === manifestTitle);
		})
		.map(node => safePathSegment(node.title, 'section'));
	return [folderPath, ...segments].filter(Boolean).join('/');
}

function normalizedHeadingTitle(value: string): string {
	return value
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~#]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLocaleLowerCase();
}

function indexPageTitle(nodeTitle: string, pageTitle: string, locale?: string): string {
	if (
		isChineseDocumentationLocale(locale) &&
		!/\p{Script=Han}/u.test(nodeTitle) &&
		/\p{Script=Han}/u.test(pageTitle)
	) return pageTitle;
	return nodeTitle || pageTitle;
}

export function normalizeMergedPageBody(
	body: string,
	pageTitle: string,
	pageHeadingLevel: number
): string {
	const lines = body.replace(/\r\n?/g, '\n').split('\n');
	let fence: { marker: string; length: number } | null = null;
	const headingIndexes: Array<{ index: number; level: number; text: string }> = [];

	for (let index = 0; index < lines.length; index += 1) {
		const fenceMatch = lines[index].match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (!fence) fence = { marker, length: fenceMatch[1].length };
			else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
			continue;
		}
		if (fence) continue;
		const heading = lines[index].match(/^( {0,3})(#{1,6})[\t ]+(.+?)\s*#*\s*$/);
		if (heading) headingIndexes.push({ index, level: heading[2].length, text: heading[3] });
	}

	const firstHeading = headingIndexes[0];
	if (
		firstHeading &&
		normalizedHeadingTitle(firstHeading.text) === normalizedHeadingTitle(pageTitle)
	) {
		lines[firstHeading.index] = '';
		headingIndexes.shift();
	}

	if (headingIndexes.length > 0) {
		const minimumLevel = Math.min(...headingIndexes.map(heading => heading.level));
		const desiredMinimum = Math.min(6, pageHeadingLevel + 1);
		const offset = Math.max(0, desiredMinimum - minimumLevel);
		for (const heading of headingIndexes) {
			const match = lines[heading.index].match(/^( {0,3})(#{1,6})([\t ].*)$/);
			if (!match) continue;
			lines[heading.index] = `${match[1]}${'#'.repeat(Math.min(6, heading.level + offset))}${match[3]}`;
		}
	}

	return lines.join('\n').trim();
}

export function buildDocumentBundleOutput(options: {
	manifest: DocumentManifest;
	pages: CollectedDocumentPage[];
	basePath: string;
	collectedAt?: Date;
	pathOverrides?: Record<string, string>;
}): DocumentBundleOutput {
	const manifestPageNames = new Set(options.manifest.pages.map(page => page.docname));
	if (options.pages.some(page => !manifestPageNames.has(page.docname))) {
		throw new Error('Collected page does not belong to the documentation manifest');
	}
	const title = safePathSegment(options.manifest.title, 'Documentation');
	const basePath = normalizeBasePath(options.basePath);
	const folderPath = [basePath, title].filter(Boolean).join('/');
	const usedPaths = new Set<string>();
	const notes: DocumentBundleNote[] = [];
	const navigation = completeNavigation(options.manifest);
	const pageByDocname = new Map(options.pages.map(page => [page.docname, page]));
	const navigationRecords = flattenNavigation(navigation, pageByDocname);
	const pathByDocname = new Map<string, string>();
	const indexLines = [
		`# ${options.manifest.title}`,
		'',
		`${isChineseDocumentationLocale(options.manifest.locale) ? '来源' : 'Source'}: ${options.manifest.rootUrl}`,
	];
	if (options.collectedAt) {
		indexLines.push(`${isChineseDocumentationLocale(options.manifest.locale) ? '采集时间' : 'Collected'}: ${options.collectedAt.toISOString()}`);
	}
	indexLines.push('', `## ${isChineseDocumentationLocale(options.manifest.locale) ? '目录' : 'Contents'}`, '');

	const mergedLines: string[] = [
		`# ${options.manifest.title}`,
		'',
		`Source: ${options.manifest.rootUrl}`,
		'',
	];

	for (const record of navigationRecords) {
		const { page } = record;
		const directory = noteDirectory(folderPath, record.ancestors, options.manifest.title);
		const baseName = safePathSegment(page.noteName || page.title, 'Untitled');
		let path = options.pathOverrides?.[page.docname] || `${directory}/${baseName}.md`;
		if (!options.pathOverrides?.[page.docname] && usedPaths.has(path.toLowerCase())) {
			const leaf = safePathSegment(page.docname.split('/').pop() || '', 'page');
			let suffix = 1;
			path = `${directory}/${baseName} - ${leaf}.md`;
			while (usedPaths.has(path.toLowerCase())) {
				suffix += 1;
				path = `${directory}/${baseName} - ${leaf}-${suffix}.md`;
			}
		}
		usedPaths.add(path.toLowerCase());
		pathByDocname.set(page.docname, path);
		notes.push({ path, content: page.content, sourceUrl: page.url, pageId: page.docname });
	}

	const renderIndex = (nodes: DocumentNavigationNode[], listDepth = 0, sectionDepth = 0): void => {
		for (const node of nodes) {
			if (node.docname) {
				const path = pathByDocname.get(node.docname);
				const collectedTitle = pageByDocname.get(node.docname)?.title || node.docname;
				const pageTitle = indexPageTitle(node.title, collectedTitle, options.manifest.locale);
				if (path) indexLines.push(`${'  '.repeat(listDepth)}- [[${path.replace(/\.md$/i, '')}|${pageTitle}]]`);
				renderIndex(node.children, listDepth + 1, sectionDepth);
			} else if (node.children.length > 0) {
				indexLines.push('', `${'#'.repeat(Math.min(6, 2 + sectionDepth))} ${node.title}`, '');
				renderIndex(node.children, 0, sectionDepth + 1);
			}
		}
	};
	renderIndex(navigation);

	const renderMerged = (nodes: DocumentNavigationNode[], depth = 0): void => {
		for (const node of nodes) {
			const headingLevel = Math.min(6, 2 + depth);
			if (node.docname) {
				const page = pageByDocname.get(node.docname);
				if (page) {
					mergedLines.push(
						`${'#'.repeat(headingLevel)} ${page.title}`,
						'',
						`Source: ${page.url}`,
						'',
						normalizeMergedPageBody(page.body ?? page.content, page.title, headingLevel),
						'',
						'---',
						''
					);
				}
			} else if (node.children.length > 0) {
				mergedLines.push(`${'#'.repeat(headingLevel)} ${node.title}`, '');
			}
			renderMerged(node.children, depth + 1);
		}
	};
	renderMerged(navigation);

	const indexContent = `${indexLines.join('\n')}\n`;
	notes.push({
		path: `${folderPath}/00 - Documentation index.md`,
		content: indexContent,
		sourceUrl: options.manifest.rootUrl,
	});

	return {
		title: options.manifest.title,
		folderPath,
		notes,
		indexContent,
		mergedNoteName: `${title} - Complete documentation`,
		mergedContent: `${mergedLines.join('\n').replace(/\n---\n\s*$/, '\n')}\n`,
	};
}
