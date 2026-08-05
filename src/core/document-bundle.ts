import { clip, clipMarkdown, type DocumentParser } from '../api';
import type { Template } from '../types/types';
import { sanitizeFileName } from '../utils/string-utils';

export const DOCUMENT_BUNDLE_MERGED_MAX_PAGES = 100;
export const DOCUMENT_BUNDLE_MAX_PAGES = DOCUMENT_BUNDLE_MERGED_MAX_PAGES;
export const DOCUMENT_COLLECTION_MAX_PAGES = 5_000;
export const DOCUMENT_BUNDLE_FETCH_CONCURRENCY = 3;

export type DocumentSourceKind = 'sphinx' | 'llms-txt' | 'llms-txt-generic' | 'google-devsite' | 'docusaurus' | 'vitepress' | 'sidebar-html' | 'sitemap' | 'aliyun-dochelp';
export type DocumentContentType = 'html' | 'markdown' | 'aliyun-json' | 'joycode-changelog-json';

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
	fetchOptions?: RequestInit;
	contentType?: DocumentContentType;
}

export interface InteractiveDocumentationSnapshot {
	url: string;
	title: string;
	html: string;
}

interface AliyunDocHelpNode {
	title?: string;
	url?: string;
	alias?: string;
	validDocument?: boolean;
	children?: AliyunDocHelpNode[];
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

export type FetchText = (url: string, options?: RequestInit) => Promise<FetchTextResult>;

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
	if (/window\.__VP_SITE_DATA__\s*=\s*JSON\.parse\(/i.test(html) ||
		(/class=["'][^"']*\bVPNavBar\b/i.test(html) && /class=["'][^"']*\bVPSidebar\b/i.test(html))) {
		return 'vitepress';
	}
	if (
		/id=["']nd-sidebar["']/i.test(html) ||
		/<aside[^>]+class=["'][^"']*\bthin-scroll\b/i.test(html) ||
		/<aside[^>]+class=["'][^"']*\bsidebar\b/i.test(html) ||
		/<(?:nav|aside)[^>]+aria-label=["']Sidebar Navigation["']/i.test(html) ||
		/<aside[^>]*>[\s\S]*?<button\b/i.test(html) ||
		/(?:id|class)=["'][^"']*(?:sidebar|sider|navigation)[^"']*["'][^>]*>[\s\S]*?<a\b[^>]+href=/i.test(html) ||
		/role=["'](?:navigation|tree)["'][^>]*>[\s\S]*?<a\b[^>]+href=/i.test(html) ||
		/class=["'][^"']*navList[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*menuItem[^"']*["']/i.test(html)
	) {
		return 'sidebar-html';
	}
	if (url.pathname.includes('/docs') && /<nav\b[^>]*>[\s\S]*?<a\b[^>]+href=/i.test(html)) {
		return 'sidebar-html';
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

function isAllowedDocumentationRedirect(root: URL, finalUrl: URL): boolean {
	if (finalUrl.origin === root.origin) return true;
	if (finalUrl.hostname === root.hostname &&
		['http:', 'https:'].includes(finalUrl.protocol) && ['http:', 'https:'].includes(root.protocol)) return true;
	// OpenAI currently serves some pages listed on developers.openai.com from
	// the official learn.chatgpt.com documentation host.
	return root.hostname === 'developers.openai.com' && finalUrl.hostname === 'learn.chatgpt.com';
}

export function buildInteractiveSidebarManifest(
	currentUrl: string,
	currentHtml: string,
	snapshots: InteractiveDocumentationSnapshot[]
): DocumentManifest {
	const current = new URL(currentUrl);
	const root = new URL(current.pathname.endsWith('/') ? current.pathname : `${current.pathname}/`, current.origin);
	const title = plainTitle(currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation', 'Documentation');
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const [index, snapshot] of snapshots.entries()) {
		let url: URL;
		try { url = new URL(snapshot.url); } catch { continue; }
		if (url.origin !== current.origin || seen.has(url.toString())) continue;
		seen.add(url.toString());
		const fragment = url.hash.replace(/^#/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
		const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
		const docname = isSafeDocname(`${path || 'index'}${fragment ? `-${fragment}` : ''}`)
			? `${path || 'index'}${fragment ? `-${fragment}` : ''}`
			: `chapter-${index + 1}`;
		pages.push({
			docname,
			title: plainTitle(snapshot.title, `Chapter ${index + 1}`),
			url: url.toString(),
			fetchUrl: url.toString(),
			contentType: 'html',
		});
	}
	if (pages.length === 0) throw new Error('No interactive documentation pages were captured');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	const locale = vitePressLocale(currentUrl, currentHtml);
	return {
		kind: 'sidebar-html', title, rootUrl: root.toString(), locale,
		collectionId: stableCollectionId('sidebar-html', root.toString(), locale),
		pages,
	};
}

function parseAliyunMenuPayload(source: string): AliyunDocHelpNode {
	const outer = JSON.parse(source) as { data?: { Data?: string | AliyunDocHelpNode } };
	const encoded = outer.data?.Data;
	const root = typeof encoded === 'string' ? JSON.parse(encoded) as AliyunDocHelpNode : encoded;
	if (!root || !Array.isArray(root.children)) throw new Error('阿里云百炼官方文档目录返回格式无效');
	return root;
}

function aliyunMenuSelection(currentUrl: string): number {
	const url = new URL(currentUrl);
	const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '';
	const hashParams = new URLSearchParams(hashQuery);
	const type = hashParams.get('type') === 'app' ? 'app' : 'model';
	const section = /^#\/api(?:\/|\?|$)/.test(url.hash) || url.searchParams.get('tab') === 'api'
		? 'api'
		: 'docs';
	if (section === 'docs') return type === 'app' ? 1 : 0;
	return type === 'app' ? 3 : 2;
}

function aliyunNodeNavigation(node: AliyunDocHelpNode, pages: DocumentPageManifest[]): DocumentNavigationNode | null {
	const children = (node.children || [])
		.map(child => aliyunNodeNavigation(child, pages))
		.filter((child): child is DocumentNavigationNode => Boolean(child));
	const alias = typeof node.alias === 'string' ? node.alias.replace(/^\/+|\/+$/g, '') : '';
	const page = node.validDocument && alias
		? pages.find(candidate => candidate.docname === alias)
		: undefined;
	if (!page && children.length === 0) return null;
	return { title: plainTitle(node.title || page?.title || 'Documentation', 'Documentation'), docname: page?.docname, children };
}

export function buildAliyunDocHelpManifest(currentUrl: string, source: string): DocumentManifest {
	const root = parseAliyunMenuPayload(source);
	const selected = root.children?.[aliyunMenuSelection(currentUrl)];
	if (!selected) throw new Error('未找到当前百炼文档分类的官方目录');
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	const visit = (node: AliyunDocHelpNode) => {
		const alias = typeof node.alias === 'string' ? node.alias.replace(/^\/+|\/+$/g, '') : '';
		if (node.validDocument && alias && !seen.has(alias)) {
			seen.add(alias);
			const canonicalPath = node.url?.startsWith('/') ? node.url : `/zh/${alias}`;
			pages.push({
				docname: alias,
				title: plainTitle(node.title || decodedPathTitle(alias, alias), decodedPathTitle(alias, alias)),
				url: new URL(canonicalPath, 'https://help.aliyun.com').toString(),
				fetchUrl: `https://help.aliyun.com/help/json/document_detail.json?alias=${encodeURIComponent(`/${alias}`)}&pageNum=1&pageSize=20&website=cn&language=zh&channel=`,
				contentType: 'aliyun-json',
			});
		}
		for (const child of node.children || []) visit(child);
	};
	visit(selected);
	if (pages.length === 0) throw new Error('当前百炼文档分类的官方目录中没有可保存页面');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	const rootUrl = new URL(selected.url || '/zh/model-studio/', 'https://help.aliyun.com').toString();
	const navigation = aliyunNodeNavigation(selected, pages);
	return {
		kind: 'aliyun-dochelp',
		title: plainTitle(selected.title || root.title || '阿里云百炼文档', '阿里云百炼文档'),
		rootUrl,
		locale: 'zh-cn',
		collectionId: stableCollectionId('aliyun-dochelp', rootUrl, 'zh-cn'),
		pages,
		navigation: navigation ? [navigation] : undefined,
	};
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
	const candidates: Array<{
		link: LlmsTxtIndex['links'][number];
		resourceUrl: URL;
		contentType: DocumentContentType;
	}> = [];
	for (const link of index.links) {
		let resourceUrl: URL;
		try { resourceUrl = new URL(link.url); } catch { continue; }
		if (resourceUrl.origin !== current.origin) continue;
		const lowerPath = resourceUrl.pathname.toLowerCase();
		if (lowerPath.endsWith('/llms.txt') || lowerPath.endsWith('.xml') || lowerPath.endsWith('/robots.txt')) continue;
		const contentType: DocumentContentType = lowerPath.endsWith('.md') ? 'markdown' : 'html';
		const linkLocaleSegment = resourceUrl.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i)?.[1]?.toLowerCase();
		if (currentLocaleSegment && linkLocaleSegment && linkLocaleSegment !== currentLocaleSegment) continue;
		resourceUrl.search = '';
		resourceUrl.hash = '';
		candidates.push({ link, resourceUrl, contentType });
	}
	const commonSegments = candidates[0]?.resourceUrl.pathname.split('/').filter(Boolean).slice(0, -1) || [];
	for (const candidate of candidates.slice(1)) {
		const segments = candidate.resourceUrl.pathname.split('/').filter(Boolean).slice(0, -1);
		while (commonSegments.length > 0 && commonSegments.some((segment, index) => segments[index] !== segment)) {
			commonSegments.pop();
		}
	}
	const root = new URL(`/${commonSegments.join('/')}${commonSegments.length ? '/' : ''}`, current.origin);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const { link, resourceUrl, contentType } of candidates) {
		const rawRelative = resourceUrl.pathname.slice(root.pathname.length);
		const relative = contentType === 'markdown' ? rawRelative.slice(0, -3) : rawRelative.replace(/\/$/, '') || 'index';
		const docname = normalizedSafeDocname(relative);
		if (!docname || seen.has(docname)) continue;
		seen.add(docname);
		pages.push({
			docname,
			title: plainTitle(link.title, decodedPathTitle(docname, docname)),
			url: contentType === 'markdown' ? new URL(rawRelative.slice(0, -3), root).toString() : resourceUrl.toString(),
			fetchUrl: resourceUrl.toString(),
			contentType,
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

export function buildLocaleSitemapManifest(
	currentUrl: string,
	currentHtml: string,
	locations: string[]
): DocumentManifest {
	const current = new URL(currentUrl);
	const locale = current.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i)?.[1];
	if (!locale) throw new Error('Current documentation URL has no locale root');
	const root = new URL(`/${locale}/`, current.origin);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const location of locations) {
		let url: URL;
		try { url = new URL(location); } catch { continue; }
		url.search = '';
		url.hash = '';
		if (url.origin !== current.origin ||
			(url.pathname !== root.pathname.slice(0, -1) && !url.pathname.startsWith(root.pathname))) continue;
		const relative = url.pathname === root.pathname.slice(0, -1)
			? 'index'
			: url.pathname.slice(root.pathname.length).replace(/\/$/, '') || 'index';
		const docname = normalizedSafeDocname(relative);
		if (!docname || seen.has(docname)) continue;
		seen.add(docname);
		pages.push({ docname, title: decodedPathTitle(docname, docname), url: url.toString(), contentType: 'html' });
	}
	if (pages.length === 0) throw new Error('Sitemap contains no pages for the current locale');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	pages.sort((left, right) => left.docname === 'index' ? -1 : right.docname === 'index' ? 1 : left.docname.localeCompare(right.docname));
	const title = plainTitle(currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation', 'Documentation');
	return {
		kind: 'sitemap', title, rootUrl: root.toString(), locale,
		collectionId: stableCollectionId('sitemap', root.toString(), locale),
		pages, navigation: fallbackNavigation(pages),
	};
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
	const docsRootPath = current.pathname.match(/^(.*\/docs\/)/i)?.[1] || '';
	const sourceRootPath = docsRootPath || `${localePrefix || ''}/`;
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
		if (canonical.origin !== current.origin ||
			(docsRootPath && canonical.pathname !== sourceRootPath.replace(/\/$/, '') && !canonical.pathname.startsWith(sourceRootPath))) continue;
		let relative = docsRootPath
			? canonical.pathname.slice(sourceRootPath.length).replace(/^\/+|\/+$/g, '') || 'index'
			: canonical.pathname.replace(/^\/+|\/+$/g, '') || 'index';
		if (!docsRootPath && localePrefix && relative.startsWith(`${localePrefix.slice(1)}/`)) {
			relative = relative.slice(localePrefix.length).replace(/^\/+/, '') || 'index';
		}
		if (current.hostname === 'joycode.jd.com' && relative === 'tags') continue;
		if (!isSafeDocname(relative) || seen.has(relative)) continue;
		seen.add(relative);
		const localizedPath = docsRootPath
			? (relative === 'index' ? sourceRootPath : `${sourceRootPath}${relative}`)
			: (relative === 'index' ? `${localePrefix || ''}/` : `${localePrefix || ''}/${relative}`);
		const pageUrl = new URL(localizedPath, current.origin).toString();
		pages.push(current.hostname === 'joycode.jd.com' && relative === 'changelog'
			? {
				docname: relative,
				title: 'JoyCode IDE 版本变更记录',
				url: pageUrl,
				fetchUrl: 'https://joycode.jd.com/api/saas/ideVersion/v1/ideVersionList',
				fetchOptions: {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ pluginId: 'joycoder-ide', plat: 'IDE' }),
				},
				contentType: 'joycode-changelog-json',
			}
			: { docname: relative, title: decodedPathTitle(relative, relative), url: pageUrl, contentType: 'html' });
	}
	if (pages.length === 0) throw new Error('Docusaurus sitemap contains no documentation pages');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	pages.sort((left, right) => left.docname === 'index' ? -1 : right.docname === 'index' ? 1 : left.docname.localeCompare(right.docname));
	return {
		kind: 'docusaurus', title, rootUrl: new URL(sourceRootPath, current.origin).toString(), locale,
		collectionId: stableCollectionId('docusaurus', new URL(sourceRootPath, current.origin).toString(), locale),
		pages, navigation: fallbackNavigation(pages),
	};
}

interface VitePressSidebarItemData {
	text?: unknown;
	link?: unknown;
	items?: unknown;
}

function parseVitePressSiteData(html: string): Record<string, unknown> | null {
	const payload = html.match(/window\.__VP_SITE_DATA__\s*=\s*JSON\.parse\(("(?:\\.|[^"\\])*")\)/i)?.[1];
	if (!payload) return null;
	try {
		const decoded = JSON.parse(payload);
		const data = JSON.parse(decoded);
		return data && typeof data === 'object' ? data as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function vitePressLocale(currentUrl: string, currentHtml: string): string {
	return (currentHtml.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] ||
		new URL(currentUrl).pathname.match(/\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i)?.[1] || 'en').toLowerCase();
}

function vitePressConfig(data: Record<string, unknown>, locale: string): Record<string, unknown> {
	const locales = data.locales && typeof data.locales === 'object'
		? data.locales as Record<string, unknown>
		: {};
	const localeConfig = Object.entries(locales).find(([key]) => key.toLowerCase() === locale)?.[1];
	if (localeConfig && typeof localeConfig === 'object') {
		const themeConfig = (localeConfig as Record<string, unknown>).themeConfig;
		if (themeConfig && typeof themeConfig === 'object') return themeConfig as Record<string, unknown>;
	}
	const themeConfig = data.themeConfig;
	return themeConfig && typeof themeConfig === 'object' ? themeConfig as Record<string, unknown> : {};
}

function vitePressSidebarItems(
	sidebar: unknown,
	currentPath: string,
	basePath: string
): VitePressSidebarItemData[] {
	if (Array.isArray(sidebar)) return sidebar as VitePressSidebarItemData[];
	if (!sidebar || typeof sidebar !== 'object') return [];
	const entries = Object.entries(sidebar as Record<string, unknown>);
	const normalizedPath = currentPath.replace(/\.html$/, '').replace(/\/$/, '') || '/';
	const matching = entries
		.filter(([key]) => normalizedPath.startsWith(key.replace(/\/$/, '') || '/'))
		.sort((left, right) => right[0].length - left[0].length)[0];
	const selected = matching?.[1] || entries[0]?.[1];
	return Array.isArray(selected) ? selected as VitePressSidebarItemData[] :
		selected && typeof selected === 'object' ? [selected as VitePressSidebarItemData] : [];
}

function vitePressPageUrl(rawLink: string, origin: string, basePath: string): URL | null {
	let url: URL;
	try {
		if (/^https?:\/\//i.test(rawLink)) url = new URL(rawLink);
		else if (rawLink.startsWith('/')) {
			const path = rawLink.startsWith(basePath) ? rawLink : `${basePath}${rawLink.slice(1)}`;
			url = new URL(path, origin);
		} else url = new URL(rawLink, `${origin}${basePath}`);
	} catch {
		return null;
	}
	if (url.origin !== origin || !url.pathname.startsWith(basePath)) return null;
	url.search = '';
	url.hash = '';
	if (url.pathname.endsWith('/')) url.pathname += 'index.html';
	else if (!/\.[a-z0-9]+$/i.test(url.pathname)) url.pathname += '.html';
	return url;
}

function vitePressCommonBasePath(urls: URL[], currentUrl: string): string {
	const pathSegments = urls.map(url => url.pathname.split('/').filter(Boolean).slice(0, -1));
	const currentSegments = new URL(currentUrl).pathname.split('/').filter(Boolean).slice(0, -1);
	const candidates = pathSegments.length > 0 ? pathSegments : [currentSegments];
	const common: string[] = [];
	for (let index = 0; index < Math.min(...candidates.map(parts => parts.length)); index += 1) {
		const segment = candidates[0][index];
		if (!candidates.every(parts => parts[index] === segment)) break;
		common.push(segment);
	}
	return `/${common.join('/')}${common.length > 0 ? '/' : ''}`;
}

export function buildHtmlSidebarManifest(
	currentUrl: string,
	currentHtml: string,
	documentParser: DocumentParser
): DocumentManifest {
	const current = new URL(currentUrl);
	const document = documentParser.parseFromString(currentHtml, 'text/html') as Document;
	const selectors = [
		'#nd-sidebar',
		'aside.thin-scroll',
		'aside.sidebar',
		'nav[aria-label="Sidebar Navigation"]',
		'[role="navigation"]',
		'[role="tree"]',
		'[class*="sidebar"]',
		'[class*="Sidebar"]',
		'[class*="sider"]',
		'[class*="Sider"]',
		'[class*="navList"]',
		'aside',
		'nav',
	];
	const containers = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)));
	const container = containers.sort((left, right) =>
		right.querySelectorAll('a[href]').length - left.querySelectorAll('a[href]').length
	)[0];
	if (!container) throw new Error('Official documentation sidebar was not found');
	const links = Array.from(container.querySelectorAll('a[href]'))
		.map(anchor => ({ href: anchor.getAttribute('href') || '', title: plainTitle(anchor.textContent || '', '') }));
	const menuItems = container.querySelectorAll('[class*="menuItem"], button').length;
	if (links.length < 2 && menuItems >= 2) {
		const pageUrl = new URL(currentUrl);
		return {
			kind: 'sidebar-html',
			title: plainTitle(currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation', 'Documentation'),
			rootUrl: pageUrl.toString(),
			locale: vitePressLocale(currentUrl, currentHtml),
			collectionId: stableCollectionId('sidebar-html', pageUrl.toString(), vitePressLocale(currentUrl, currentHtml)),
			pages: [{
				docname: 'index',
				title: plainTitle(currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation', 'Documentation'),
				url: pageUrl.toString(),
				contentType: 'html',
			}],
		};
	}
	const urls = links.map(link => {
		try { return new URL(link.href, currentUrl); } catch { return null; }
	}).filter((url): url is URL => url !== null && url.origin === current.origin);
	const rootPath = vitePressCommonBasePath(urls, currentUrl);
	const root = new URL(rootPath, current.origin);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const link of links) {
		let url: URL;
		try { url = new URL(link.href, currentUrl); } catch { continue; }
		url.search = '';
		url.hash = '';
		if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) continue;
		const relative = url.pathname.slice(root.pathname.length).replace(/^\/+|\/+$/g, '') || 'index';
		const docname = normalizedSafeDocname(relative);
		if (!docname || seen.has(url.toString())) continue;
		seen.add(url.toString());
		pages.push({
			docname,
			title: link.title || decodedPathTitle(docname, docname),
			url: url.toString(),
			contentType: 'html',
		});
	}
	if (pages.length === 0) throw new Error('Official documentation sidebar contains no same-origin pages');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	const locale = vitePressLocale(currentUrl, currentHtml);
	const title = plainTitle(currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation', 'Documentation');
	return {
		kind: 'sidebar-html',
		title,
		rootUrl: root.toString(),
		locale,
		collectionId: stableCollectionId('sidebar-html', root.toString(), locale),
		pages,
	};
}

function buildVitePressDomPages(
	currentUrl: string,
	currentHtml: string,
	documentParser?: DocumentParser
): { pages: DocumentPageManifest[]; rootUrl: string } {
	if (!documentParser) throw new Error('VitePress site data was not found');
	const document = documentParser.parseFromString(currentHtml, 'text/html') as Document;
	const current = new URL(currentUrl);
	const links = Array.from(document.querySelectorAll('.VPSidebar a[href]'))
		.map(anchor => ({
			href: anchor.getAttribute('href') || '',
			title: plainTitle(anchor.textContent || '', ''),
		}));
	const urls = links.map(link => {
		try { return new URL(link.href, currentUrl); } catch { return null; }
	}).filter((url): url is URL => url !== null && url.origin === current.origin);
	const basePath = vitePressCommonBasePath(urls, currentUrl);
	const base = new URL(basePath, current.origin);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	for (const link of links) {
		const pageUrl = vitePressPageUrl(link.href, current.origin, base.pathname);
		if (!pageUrl || seen.has(pageUrl.toString())) continue;
		const relative = pageUrl.pathname.slice(base.pathname.length).replace(/\.html$/, '').replace(/\/$/, '') || 'index';
		if (!isSafeDocname(relative)) continue;
		seen.add(pageUrl.toString());
		pages.push({
			docname: relative,
			title: link.title || decodedPathTitle(relative, relative),
			url: pageUrl.toString(),
			contentType: 'html',
		});
	}
	return { pages, rootUrl: base.toString() };
}

export function buildVitePressManifest(
	currentUrl: string,
	currentHtml: string,
	documentParser?: DocumentParser
): DocumentManifest {
	const current = new URL(currentUrl);
	const data = parseVitePressSiteData(currentHtml);
	const locale = vitePressLocale(currentUrl, currentHtml);
	if (!data) {
		const fallback = buildVitePressDomPages(currentUrl, currentHtml, documentParser);
		if (fallback.pages.length === 0) throw new Error('VitePress sidebar contains no documentation pages');
		return {
			kind: 'vitepress',
			title: plainTitle(currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation', 'Documentation'),
			rootUrl: fallback.rootUrl,
			locale,
			collectionId: stableCollectionId('vitepress', fallback.rootUrl, locale),
			pages: fallback.pages,
		};
	}
	const rawBase = typeof data.base === 'string' ? data.base : '/';
	const base = new URL(rawBase, current.origin);
	base.search = '';
	base.hash = '';
	if (!base.pathname.endsWith('/')) base.pathname += '/';
	const config = vitePressConfig(data, locale);
	const sidebar = vitePressSidebarItems(config.sidebar, current.pathname, base.pathname);
	const pages: DocumentPageManifest[] = [];
	const seen = new Set<string>();
	const addItem = (item: VitePressSidebarItemData): DocumentNavigationNode | null => {
		const rawLink = typeof item.link === 'string' ? item.link : '';
		const pageUrl = rawLink ? vitePressPageUrl(rawLink, current.origin, base.pathname) : null;
		const page = pageUrl && pageUrl.pathname.startsWith(base.pathname)
			? (() => {
				const relative = pageUrl.pathname.slice(base.pathname.length).replace(/\.html$/, '').replace(/\/$/, '') || 'index';
				if (!isSafeDocname(relative)) return null;
				const key = pageUrl.toString();
				if (seen.has(key)) return pages.find(candidate => candidate.url === key) || null;
				const created = {
					docname: relative,
					title: plainTitle(typeof item.text === 'string' ? item.text : '', decodedPathTitle(relative, relative)),
					url: key,
					contentType: 'html' as const,
				};
				seen.add(key);
				pages.push(created);
				return created;
			})()
			: null;
		const children = Array.isArray(item.items)
			? item.items.map(child => child && typeof child === 'object' ? addItem(child as VitePressSidebarItemData) : null).filter(Boolean) as DocumentNavigationNode[]
			: [];
		if (!page && children.length === 0) return null;
		return page
			? { docname: page.docname, title: page.title, children }
			: { title: plainTitle(typeof item.text === 'string' ? item.text : '', 'Section'), children };
	};
	const navigation = sidebar.map(item => item && typeof item === 'object' ? addItem(item) : null).filter(Boolean) as DocumentNavigationNode[];
	if (pages.length === 0) throw new Error('VitePress sidebar contains no documentation pages');
	if (pages.length > DOCUMENT_COLLECTION_MAX_PAGES) throw new Error(`Documentation contains more than ${DOCUMENT_COLLECTION_MAX_PAGES} pages`);
	const titleFromHtml = currentHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Documentation';
	const title = plainTitle(titleFromHtml.replace(/\s*[|–—-]\s*[^|–—]+$/, ''), 'Documentation');
	return {
		kind: 'vitepress',
		title: locale === 'en' ? title : `${title} - ${locale}`,
		rootUrl: base.toString(),
		locale,
		collectionId: stableCollectionId('vitepress', base.toString(), locale),
		pages,
		navigation,
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

function normalizedSafeDocname(docname: string): string | null {
	const normalized = docname.split('/').map(segment => {
		let decoded = segment;
		try { decoded = decodeURIComponent(segment); } catch { /* keep the encoded segment */ }
		return decoded
			.replace(/[^\p{L}\p{N}_.-]+/gu, '-')
			.replace(/-+/g, '-')
			.replace(/^-+|-+$/g, '');
	}).filter(Boolean).join('/');
	return isSafeDocname(normalized) ? normalized : null;
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
	const rootIndex = parseLlmsTxt(response.text);
	const combinedLinks = [...rootIndex.links];
	const origin = new URL(options.currentUrl).origin;
	const visited = new Set([finalUrl.toString()]);
	const queue = rootIndex.links.map(link => link.url).filter(url => {
		try {
			const candidate = new URL(url);
			return candidate.origin === origin && candidate.pathname.endsWith('/llms.txt');
		} catch { return false; }
	});
	while (queue.length > 0) {
		if (visited.size >= 32) throw new Error('llms.txt contains too many nested indexes');
		const nestedUrl = queue.shift()!;
		if (visited.has(nestedUrl)) continue;
		visited.add(nestedUrl);
		const nestedResponse = await options.fetchText(nestedUrl);
		if (!nestedResponse.ok) continue;
		const nestedFinalUrl = new URL(nestedResponse.finalUrl || nestedUrl);
		if (nestedFinalUrl.origin !== origin) continue;
		let nestedIndex: LlmsTxtIndex;
		try { nestedIndex = parseLlmsTxt(nestedResponse.text); } catch { continue; }
		combinedLinks.push(...nestedIndex.links);
		for (const link of nestedIndex.links) {
			try {
				const candidate = new URL(link.url);
				if (candidate.origin === origin && candidate.pathname.endsWith('/llms.txt') && !visited.has(candidate.toString())) {
					queue.push(candidate.toString());
				}
			} catch { /* ignore invalid nested links */ }
		}
	}
	return buildGenericLlmsTxtManifest(options.currentUrl, options.currentHtml, {
		title: rootIndex.title,
		links: combinedLinks,
	});
}

async function discoverHtmlSidebarDocumentation(options: {
	currentUrl: string;
	currentHtml: string;
	fetchText: FetchText;
	documentParser?: DocumentParser;
}): Promise<DocumentManifest> {
	const current = new URL(options.currentUrl);
	if (/^\/[a-z]{2}(?:-[a-z]{2})?(?:\/|$)/i.test(current.pathname)) {
		const sitemapUrl = new URL('/sitemap.xml', current.origin).toString();
		const response = await options.fetchText(sitemapUrl);
		if (response.ok) {
			const finalUrl = new URL(response.finalUrl || sitemapUrl);
			if (finalUrl.origin === current.origin) {
				try {
					return buildLocaleSitemapManifest(
						options.currentUrl,
						options.currentHtml,
						parseSitemapLocations(response.text)
					);
				} catch { /* fall back to the rendered official sidebar */ }
			}
		}
	}
	if (!options.documentParser) throw new Error('A document parser is required for sidebar discovery');
	return buildHtmlSidebarManifest(options.currentUrl, options.currentHtml, options.documentParser);
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
		kind: 'vitepress',
		matches: (currentUrl, currentHtml) => detectDocumentSourceKind(currentUrl, currentHtml) === 'vitepress',
		discover: async options => buildVitePressManifest(options.currentUrl, options.currentHtml, options.documentParser),
	},
	{
		kind: 'sidebar-html',
		matches: (currentUrl, currentHtml) => detectDocumentSourceKind(currentUrl, currentHtml) === 'sidebar-html',
		discover: options => discoverHtmlSidebarDocumentation(options),
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
	currentPageUrl?: string;
	currentPageHtml?: string;
	pageSnapshots?: Map<string, string>;
}): Promise<CollectedDocumentPage[]> {
	const sourcePages = options.pages || options.manifest.pages;
	const results = new Array<CollectedDocumentPage | undefined>(sourcePages.length);
	const defaultConcurrency = options.manifest.kind === 'aliyun-dochelp'
		? 2
		: DOCUMENT_BUNDLE_FETCH_CONCURRENCY;
	const concurrency = Math.max(
		1,
		Math.min(options.concurrency || defaultConcurrency, 6)
	);
	let nextIndex = 0;
	let completed = 0;
	const root = new URL(options.manifest.rootUrl);

	const worker = async () => {
		while (true) {
			const pageIndex = nextIndex;
			nextIndex += 1;
			if (pageIndex >= sourcePages.length) return;
			const page = sourcePages[pageIndex];
			const requestUrl = page.fetchUrl || page.url;
			const snapshotHtml = options.pageSnapshots?.get(requestUrl);
			let response: FetchTextResult = snapshotHtml
				? { ok: true, status: 200, finalUrl: requestUrl, text: snapshotHtml }
				: options.currentPageUrl === requestUrl && options.currentPageHtml
				? { ok: true, status: 200, finalUrl: requestUrl, text: options.currentPageHtml }
				: await options.fetchText(requestUrl, page.fetchOptions);
			let aliyunPayload: { data?: { content?: string; title?: string } } | undefined;
			if (page.contentType === 'aliyun-json') {
				const retryDelays = [300, 700, 1_500];
				for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
					try {
						aliyunPayload = response.ok
							? JSON.parse(response.text) as { data?: { content?: string; title?: string } }
							: undefined;
					} catch {
						aliyunPayload = undefined;
					}
					if (aliyunPayload?.data?.content) break;
					if (attempt === retryDelays.length) {
						if (!response.ok) {
							throw new Error(`阿里云文档正文请求失败：${page.title}（${response.status || response.error || '网络错误'}）`);
						}
						throw new Error(`阿里云文档正文连续 ${retryDelays.length + 1} 次返回为空：${page.title}`);
					}
					await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
					const retryUrl = new URL(requestUrl);
					retryUrl.searchParams.set('_clipper_retry', `${Date.now()}-${pageIndex}-${attempt + 1}`);
					response = await options.fetchText(retryUrl.toString());
				}
			}
			if (!response.ok) {
				throw new Error(`Failed to fetch ${page.title} (${response.status || response.error || 'network error'})`);
			}
			const finalUrl = new URL(response.finalUrl || requestUrl);
			if (!isAllowedDocumentationRedirect(root, finalUrl)) {
				throw new Error(`Documentation page redirected outside its origin: ${requestUrl}`);
			}
			const sourceUrl = page.contentType === 'markdown' || page.contentType === 'aliyun-json' || page.contentType === 'joycode-changelog-json'
				? page.url
				: finalUrl.toString();
			let responseText = response.text;
			if (page.contentType === 'aliyun-json') {
				const title = aliyunPayload?.data?.title || page.title;
				responseText = `<!doctype html><html lang="zh-CN"><head><title>${title.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character)}</title></head><body><main>${aliyunPayload?.data?.content || ''}</main></body></html>`;
			}
			if (page.contentType === 'joycode-changelog-json') {
				let payload: { code?: number; data?: Array<{ semver?: string; publishedAt?: number; releaseNotes?: string }> };
				try {
					payload = JSON.parse(response.text) as { code?: number; data?: Array<{ semver?: string; publishedAt?: number; releaseNotes?: string }> };
				} catch {
					throw new Error('JoyCode 版本记录接口返回格式无效');
				}
				if (payload.code !== 0 || !Array.isArray(payload.data) || payload.data.length === 0) {
					throw new Error('JoyCode 版本记录接口未返回正文');
				}
				const entries = [...payload.data]
					.sort((left, right) => (right.publishedAt || 0) - (left.publishedAt || 0))
					.map(entry => {
						const date = entry.publishedAt ? new Date(entry.publishedAt).toISOString().slice(0, 10) : '';
						return `<section><h2>v${entry.semver || '未知版本'}${date ? ` - ${date}` : ''}</h2>${entry.releaseNotes || ''}</section>`;
					}).join('\n');
				responseText = `<!doctype html><html lang="zh-CN"><head><title>JoyCode IDE 版本变更记录</title></head><body><main><h1>JoyCode IDE 版本变更记录</h1>${entries}</main></body></html>`;
			}
			const preparedSource = page.contentType === 'markdown'
				? normalizeDocumentationMarkdown(response.text, sourceUrl)
				: preserveDocumentationCardGrids(responseText, sourceUrl, options.documentParser);
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
