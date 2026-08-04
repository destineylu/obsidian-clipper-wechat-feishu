import { clip, type DocumentParser } from '../api';
import type { Template } from '../types/types';
import { sanitizeFileName } from '../utils/string-utils';

export const DOCUMENT_BUNDLE_MAX_PAGES = 100;
export const DOCUMENT_BUNDLE_FETCH_CONCURRENCY = 3;

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
}

export interface DocumentNavigationNode {
	title: string;
	docname?: string;
	children: DocumentNavigationNode[];
}

export interface DocumentManifest {
	kind: 'sphinx';
	title: string;
	rootUrl: string;
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
	if (pages.length > DOCUMENT_BUNDLE_MAX_PAGES) {
		throw new Error(`Documentation contains more than ${DOCUMENT_BUNDLE_MAX_PAGES} pages`);
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
	missingPages: DocumentPageManifest[]
): void {
	const indexPage = missingPages.find(page => page.docname === 'index');
	if (indexPage) {
		tree.unshift({ docname: indexPage.docname, title: indexPage.title, children: [] });
	}
	const remaining = missingPages.filter(page => page !== indexPage);
	if (remaining.length > 0) {
		tree.push({ title: 'Other pages', children: fallbackNavigation(remaining) });
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
	appendMissingNavigationPages(bestTree, missing);
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

export async function collectDocumentPages(options: {
	manifest: DocumentManifest;
	template: Template;
	propertyTypes?: Record<string, string>;
	documentParser: DocumentParser;
	fetchText: FetchText;
	concurrency?: number;
	onProgress?: (completed: number, total: number, page: DocumentPageManifest) => void;
}): Promise<CollectedDocumentPage[]> {
	const results = new Array<CollectedDocumentPage>(options.manifest.pages.length);
	const concurrency = Math.max(
		1,
		Math.min(options.concurrency || DOCUMENT_BUNDLE_FETCH_CONCURRENCY, 6)
	);
	let nextIndex = 0;
	let completed = 0;
	const root = new URL(options.manifest.rootUrl);

	const worker = async () => {
		while (true) {
			const pageIndex = nextIndex;
			nextIndex += 1;
			if (pageIndex >= options.manifest.pages.length) return;
			const page = options.manifest.pages[pageIndex];
			const response = await options.fetchText(page.url);
			if (!response.ok) {
				throw new Error(`Failed to fetch ${page.title} (${response.status || response.error || 'network error'})`);
			}
			const finalUrl = new URL(response.finalUrl || page.url);
			if (finalUrl.origin !== root.origin || !finalUrl.pathname.startsWith(root.pathname)) {
				throw new Error(`Documentation page redirected outside its root: ${page.url}`);
			}
			const result = await clip({
				html: response.text,
				url: finalUrl.toString(),
				template: options.template,
				documentParser: options.documentParser,
				propertyTypes: options.propertyTypes,
			});
			results[pageIndex] = {
				...page,
				url: finalUrl.toString(),
				noteName: result.noteName,
				content: result.fullContent,
				body: result.content,
			};
			completed += 1;
			options.onProgress?.(completed, options.manifest.pages.length, page);
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(concurrency, options.manifest.pages.length) },
			() => worker()
		)
	);
	return results;
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
	appendMissingNavigationPages(tree, missing);
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
}): DocumentBundleOutput {
	if (options.pages.length !== options.manifest.pages.length) {
		throw new Error('Collected page count does not match the documentation manifest');
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
		`Source: ${options.manifest.rootUrl}`,
	];
	if (options.collectedAt) {
		indexLines.push(`Collected: ${options.collectedAt.toISOString()}`);
	}
	indexLines.push('', '## Contents', '');

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
		let suffix = 1;
		let path = `${directory}/${baseName}.md`;
		while (usedPaths.has(path.toLowerCase())) {
			suffix += 1;
			path = `${directory}/${baseName}-${suffix}.md`;
		}
		usedPaths.add(path.toLowerCase());
		pathByDocname.set(page.docname, path);
		notes.push({ path, content: page.content, sourceUrl: page.url });
	}

	const renderIndex = (nodes: DocumentNavigationNode[], depth = 0): void => {
		for (const node of nodes) {
			if (node.docname) {
				const path = pathByDocname.get(node.docname);
				if (path) indexLines.push(`${'  '.repeat(depth)}- [[${path.replace(/\.md$/i, '')}|${node.title}]]`);
			} else if (node.children.length > 0) {
				indexLines.push(`${'  '.repeat(depth)}- **${node.title}**`);
			}
			renderIndex(node.children, depth + 1);
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
						`${'#'.repeat(headingLevel)} ${node.title}`,
						'',
						`Source: ${page.url}`,
						'',
						normalizeMergedPageBody(page.body ?? page.content, node.title, headingLevel),
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
