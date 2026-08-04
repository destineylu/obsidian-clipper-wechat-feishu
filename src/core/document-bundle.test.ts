import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';

import {
	buildDocumentBundleOutput,
	buildSphinxManifest,
	collectDocumentPages,
	isLikelySphinxDocumentationHtml,
	normalizeMergedPageBody,
	parseSphinxNavigation,
	parseSphinxSearchIndex,
} from './document-bundle';

describe('isLikelySphinxDocumentationHtml', () => {
	test('recognizes sanitized Sphinx HTML after scripts are removed', () => {
		expect(isLikelySphinxDocumentationHtml(
			'<html lang="en" data-content_root="./"><body>Docs</body></html>'
		)).toBe(true);
	});

	test('recognizes current Sphinx runtime markers', () => {
		expect(isLikelySphinxDocumentationHtml(`
			<html data-content_root="./">
				<script src="_static/documentation_options.js"></script>
				<script src="_static/sphinx_highlight.js"></script>
			</html>
		`)).toBe(true);
	});

	test('recognizes older Sphinx runtime markers', () => {
		expect(isLikelySphinxDocumentationHtml(`
			<script data-url_root="./" src="_static/documentation_options.js"></script>
			<script src="_static/doctools.js"></script>
		`)).toBe(true);
	});

	test('does not classify a generic documentation page as Sphinx', () => {
		expect(isLikelySphinxDocumentationHtml(`
			<main><h1>Documentation</h1><script src="/assets/docs.js"></script></main>
		`)).toBe(false);
	});
});

describe('parseSphinxSearchIndex', () => {
	test('parses the Search.setIndex wrapper', () => {
		const result = parseSphinxSearchIndex(
			'Search.setIndex({"docnames":["index","guide/install"],"titles":["Docs","Install"]})'
		);

		expect(result).toEqual({
			docnames: ['index', 'guide/install'],
			titles: ['Docs', 'Install'],
		});
	});

	test('accepts a trailing JavaScript semicolon', () => {
		expect(parseSphinxSearchIndex(
			'Search.setIndex({"docnames":["index"],"titles":["Docs"]});'
		).docnames).toEqual(['index']);
	});

	test('rejects non-Sphinx JavaScript', () => {
		expect(() => parseSphinxSearchIndex('alert(1)')).toThrow(/Sphinx/i);
	});
});

describe('buildSphinxManifest', () => {
	test('creates same-root HTML URLs and excludes generated pages', () => {
		const manifest = buildSphinxManifest(
			'https://docs.example.com/en/stable/',
			{
				docnames: ['index', 'guide/install', 'search', 'genindex'],
				titles: ['Example docs', 'Install', 'Search', 'Index'],
			}
		);

		expect(manifest.title).toBe('Example docs');
		expect(manifest.pages).toEqual([
			{
				docname: 'index',
				title: 'Example docs',
				url: 'https://docs.example.com/en/stable/index.html',
			},
			{
				docname: 'guide/install',
				title: 'Install',
				url: 'https://docs.example.com/en/stable/guide/install.html',
			},
		]);
	});

	test('rejects traversal and cross-root document names', () => {
		expect(() => buildSphinxManifest(
			'https://docs.example.com/en/stable/',
			{ docnames: ['../latest/index'], titles: ['Unsafe'] }
		)).toThrow(/unsafe/i);
	});

	test('enforces the page limit', () => {
		const docnames = Array.from({ length: 101 }, (_, index) => `page-${index}`);
		expect(() => buildSphinxManifest(
			'https://docs.example.com/en/stable/',
			{ docnames, titles: docnames }
		)).toThrow(/100/);
	});
});

describe('parseSphinxNavigation', () => {
	test('preserves nested navigation order and groups missing pages', () => {
		const manifest = buildSphinxManifest('https://docs.example.com/en/stable/', {
			docnames: ['index', 'guide/index', 'guide/install', 'api'],
			titles: ['Docs', 'Guide', 'Install', 'API'],
		});
		const navigation = parseSphinxNavigation({
			html: `
				<aside class="sphinxsidebar"><div class="sphinxsidebarwrapper"><ul>
					<li><a href="index.html">Docs</a></li>
					<li><a href="guide/index.html">Guide</a><ul>
						<li><a href="guide/install.html">Install</a></li>
						<li><a href="guide/install.html#duplicate">Install duplicate</a></li>
					</ul></li>
				</ul></div></aside>
			`,
			pageUrl: 'https://docs.example.com/en/stable/index.html',
			manifest,
			documentParser: { parseFromString: html => parseHTML(html).document },
		});

		expect(navigation).toEqual([
			{ docname: 'index', title: 'Docs', children: [] },
			{
				docname: 'guide/index',
				title: 'Guide',
				children: [{ docname: 'guide/install', title: 'Install', children: [] }],
			},
			{
				title: 'Other pages',
				children: [{ docname: 'api', title: 'API', children: [] }],
			},
		]);
	});

	test('preserves Sphinx caption groups as virtual parent nodes', () => {
		const manifest = buildSphinxManifest('https://docs.example.com/', {
			docnames: ['index', 'install'],
			titles: ['Docs', 'Install'],
		});
		const navigation = parseSphinxNavigation({
			html: `<nav class="wy-menu-vertical">
				<p class="caption"><span>Guides</span></p>
				<ul><li><a href="install.html">Install</a></li></ul>
			</nav>`,
			pageUrl: 'https://docs.example.com/index.html',
			manifest,
			documentParser: { parseFromString: html => parseHTML(html).document },
		});

		expect(navigation).toEqual([
			{ docname: 'index', title: 'Docs', children: [] },
			{
				title: 'Guides',
				children: [{ docname: 'install', title: 'Install', children: [] }],
			},
		]);
	});
});

describe('collectDocumentPages', () => {
	test('extracts the chapter body from fetched Sphinx HTML', async () => {
		const manifest = buildSphinxManifest('https://docs.example.com/', {
			docnames: ['installation'],
			titles: ['Installation'],
		});
		const pages = await collectDocumentPages({
			manifest,
			template: {
				id: 'default',
				name: 'Default',
				behavior: 'create',
				noteNameFormat: '{{title}}',
				path: 'Clippings',
				noteContentFormat: '{{content}}',
				context: '',
				properties: [],
				triggers: [],
			},
			documentParser: {
				parseFromString: html => parseHTML(html).document,
			},
			fetchText: async () => ({
				ok: true,
				status: 200,
				text: `<!doctype html><html data-content_root="./">
					<head><title>Installation</title></head>
					<body><main><h1>Installation</h1><p>Install shot-scraper with pip.</p></main></body>
				</html>`,
			}),
		});

		expect(pages[0].body).toContain('Install shot-scraper with pip.');
	});
});

describe('buildDocumentBundleOutput', () => {
	test('preserves nested chapter folders and generates index and merged notes', () => {
		const output = buildDocumentBundleOutput({
			manifest: {
				kind: 'sphinx',
				title: 'Example docs',
				rootUrl: 'https://docs.example.com/en/stable/',
				pages: [
					{ docname: 'index', title: 'Example docs', url: 'https://docs.example.com/en/stable/index.html' },
					{ docname: 'guide/install', title: 'Install', url: 'https://docs.example.com/en/stable/guide/install.html' },
				],
			},
			pages: [
				{ docname: 'index', title: 'Example docs', url: 'https://docs.example.com/en/stable/index.html', noteName: 'Example docs', content: '# Example docs\n\nWelcome.' },
				{ docname: 'guide/install', title: 'Install', url: 'https://docs.example.com/en/stable/guide/install.html', noteName: 'Install', content: '# Install\n\nRun it.' },
			],
			basePath: 'Reference',
			collectedAt: new Date('2026-08-03T12:00:00.000Z'),
		});

		expect(output.folderPath).toBe('Reference/Example docs');
		expect(output.notes.map(note => note.path)).toEqual([
			'Reference/Example docs/Example docs.md',
			'Reference/Example docs/guide/Install.md',
			'Reference/Example docs/00 - Documentation index.md',
		]);
		expect(output.indexContent).toContain('[[Reference/Example docs/guide/Install|Install]]');
		expect(output.indexContent).toContain('https://docs.example.com/en/stable/');
		expect(output.mergedContent).toContain('## Install');
		expect(output.mergedContent).toContain('Source: https://docs.example.com/en/stable/guide/install.html');
	});

	test('deduplicates colliding note names', () => {
		const manifest = {
			kind: 'sphinx' as const,
			title: 'Docs',
			rootUrl: 'https://docs.example.com/',
			pages: [
				{ docname: 'a/index', title: 'Index', url: 'https://docs.example.com/a/index.html' },
				{ docname: 'a/other', title: 'Other', url: 'https://docs.example.com/a/other.html' },
			],
		};
		const output = buildDocumentBundleOutput({
			manifest,
			pages: manifest.pages.map(page => ({ ...page, noteName: 'Same', content: page.title })),
			basePath: '',
		});

		expect(output.notes.slice(0, 2).map(note => note.path)).toEqual([
			'Docs/a/Same.md',
			'Docs/a/Same-2.md',
		]);
	});

	test('renders nested index links, folders, and merged heading levels', () => {
		const manifest = {
			kind: 'sphinx' as const,
			title: 'Docs',
			rootUrl: 'https://docs.example.com/',
			pages: [
				{ docname: 'guide', title: 'Guide', url: 'https://docs.example.com/guide.html' },
				{ docname: 'install', title: 'Install', url: 'https://docs.example.com/install.html' },
			],
			navigation: [{
				docname: 'guide',
				title: 'Guide',
				children: [{ docname: 'install', title: 'Install', children: [] }],
			}],
		};
		const output = buildDocumentBundleOutput({
			manifest,
			pages: [
				{ ...manifest.pages[0], noteName: 'Guide', content: '# Guide\n\nGuide body.', body: '# Guide\n\nGuide body.' },
				{ ...manifest.pages[1], noteName: 'Install', content: '# Install\n\n## Usage\n\nRun it.', body: '# Install\n\n## Usage\n\nRun it.' },
			],
			basePath: '',
		});

		expect(output.indexContent).toContain('- [[Docs/Guide|Guide]]\n  - [[Docs/Guide/Install|Install]]');
		expect(output.notes.slice(0, 2).map(note => note.path)).toEqual([
			'Docs/Guide.md',
			'Docs/Guide/Install.md',
		]);
		expect(output.mergedContent).toContain('## Guide\n\nSource: https://docs.example.com/guide.html');
		expect(output.mergedContent).toContain('### Install\n\nSource: https://docs.example.com/install.html');
		expect(output.mergedContent).toContain('#### Usage');
	});
});

describe('normalizeMergedPageBody', () => {
	test('removes the leading page title and shifts headings below the page', () => {
		expect(normalizeMergedPageBody(
			'# Install\n\nIntro.\n\n## Usage\n\n### Flags',
			'Install',
			3
		)).toBe('Intro.\n\n#### Usage\n\n##### Flags');
	});

	test('does not rewrite headings inside fenced code blocks', () => {
		expect(normalizeMergedPageBody(
			'# API\n\n```md\n# Literal heading\n```\n\n## Methods',
			'API',
			2
		)).toContain('```md\n# Literal heading\n```\n\n### Methods');
	});
});
