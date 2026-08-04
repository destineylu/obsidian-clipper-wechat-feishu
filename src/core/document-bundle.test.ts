import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';

import {
	buildDocumentBundleOutput,
	buildClaudeSitemapManifest,
	buildDocusaurusManifest,
	buildGenericLlmsTxtManifest,
	buildGoogleDevsiteManifest,
	buildLlmsTxtManifest,
	buildSphinxManifest,
	collectDocumentPages,
	detectDocumentSourceKind,
	discoverDocumentation,
	isLikelySphinxDocumentationHtml,
	normalizeMergedPageBody,
	parseLlmsTxt,
	parseDocumentationNavigation,
	parseSitemapLocations,
	parseSphinxNavigation,
	parseSphinxSearchIndex,
	restoreDocumentationCardGrids,
} from './document-bundle';

describe('documentation source detection', () => {
	test('detects Claude, Google DevSite, Docusaurus and Sphinx documentation', () => {
		expect(detectDocumentSourceKind(
			'https://platform.claude.com/docs/en/intro',
			'<html class="cds-root"><script src="/_next/static/app.js"></script></html>'
		)).toBe('llms-txt');
		expect(detectDocumentSourceKind(
			'https://ai.google.dev/gemini-api/docs',
			'<devsite-header></devsite-header>'
		)).toBe('google-devsite');
		expect(detectDocumentSourceKind(
			'https://docs.example.com/index.html',
			'<html data-content_root="./"></html>'
		)).toBe('sphinx');
		expect(detectDocumentSourceKind(
			'https://api-docs.deepseek.com/zh-cn/',
			'<html lang="zh-cn"><head><meta name="generator" content="Docusaurus v3.1.0"></head><body><div id="__docusaurus"></div></body></html>'
		)).toBe('docusaurus');
		expect(detectDocumentSourceKind(
			'https://platform.kimi.com/docs/overview',
			'<html lang="zh"><a href="/docs/llms.txt">Documentation Index</a></html>'
		)).toBe('llms-txt-generic');
	});
});

describe('Claude llms.txt discovery', () => {
	test('keeps only the current locale and creates stable Markdown pages', () => {
		const parsed = parseLlmsTxt(`# Anthropic Developer Documentation

- [Intro](https://platform.claude.com/docs/en/intro.md)
- [Tools](https://platform.claude.com/docs/en/agents/tools.md)
- [Deutsch](https://platform.claude.com/docs/de/intro.md)
- [Console](https://platform.claude.com/settings)
`);
		const manifest = buildLlmsTxtManifest(
			'https://platform.claude.com/docs/en/intro',
			parsed
		);

		expect(manifest.kind).toBe('llms-txt');
		expect(manifest.locale).toBe('en');
		expect(manifest.pages.map(page => page.docname)).toEqual([
			'intro',
			'agents/tools',
		]);
		expect(manifest.pages[0]).toMatchObject({
			url: 'https://platform.claude.com/docs/en/intro',
			fetchUrl: 'https://platform.claude.com/docs/en/intro.md',
			contentType: 'markdown',
		});
		expect(manifest.collectionId).toBe(buildLlmsTxtManifest(
			'https://platform.claude.com/docs/en/other',
			parsed
		).collectionId);
	});

	test('falls back to the official sitemap when llms.txt has no current-locale pages', async () => {
		const llms = '# Anthropic Developer Documentation\n\n- [Intro](https://platform.claude.com/docs/en/intro.md)';
		const sitemap = '<urlset><url><loc>https://platform.claude.com/docs/zh-CN/intro</loc></url><url><loc>https://platform.claude.com/docs/en/intro</loc></url></urlset>';
		const manifest = await discoverDocumentation({
			currentUrl: 'https://platform.claude.com/docs/zh-CN/intro',
			currentHtml: '<html></html>',
			fetchText: async url => ({ ok: true, status: 200, text: url.endsWith('llms.txt') ? llms : sitemap }),
		});
		expect(manifest.locale).toBe('zh-CN');
		expect(manifest.title).toBe('Anthropic Developer Documentation - zh-CN');
		expect(manifest.pages.map(page => page.url)).toEqual(['https://platform.claude.com/docs/zh-CN/intro']);
	});

	test('builds a locale-specific Claude sitemap manifest', () => {
		expect(buildClaudeSitemapManifest(
			'https://platform.claude.com/docs/zh-CN/intro',
			['https://platform.claude.com/docs/zh-CN/intro']
		).pages[0].contentType).toBe('html');
	});
});

describe('Docusaurus sitemap discovery', () => {
	test('maps canonical sitemap URLs into the current locale', () => {
		const manifest = buildDocusaurusManifest(
			'https://api-docs.deepseek.com/zh-cn/',
			'<html lang="zh-cn"><head><title>首次调用 API | DeepSeek API Docs</title><meta name="generator" content="Docusaurus v3.1.0"></head></html>',
			[
				'https://api-docs.deepseek.com/',
				'https://api-docs.deepseek.com/guides/tool_calls',
			]
		);
		expect(manifest).toMatchObject({ kind: 'docusaurus', locale: 'zh-cn' });
		expect(manifest.pages.map(page => page.url)).toEqual([
			'https://api-docs.deepseek.com/zh-cn/',
			'https://api-docs.deepseek.com/zh-cn/guides/tool_calls',
		]);
	});
});

describe('generic llms.txt discovery', () => {
	test('uses a documentation-local llms.txt index without a site-specific adapter', async () => {
		const html = '<html lang="zh"><a href="/docs/llms.txt">Documentation Index</a></html>';
		const llms = '# Kimi API 开放平台\n\n- [快速开始](https://platform.kimi.com/docs/overview.md)\n- [模型列表](https://platform.kimi.com/docs/guide/models.md)';
		const manifest = await discoverDocumentation({
			currentUrl: 'https://platform.kimi.com/docs/overview',
			currentHtml: html,
			fetchText: async url => ({ ok: url === 'https://platform.kimi.com/docs/llms.txt', status: 200, text: llms }),
		});
		expect(manifest).toMatchObject({ kind: 'llms-txt-generic', locale: 'zh', rootUrl: 'https://platform.kimi.com/docs/' });
		expect(manifest.pages.map(page => page.fetchUrl)).toEqual([
			'https://platform.kimi.com/docs/overview.md',
			'https://platform.kimi.com/docs/guide/models.md',
		]);
		expect(buildGenericLlmsTxtManifest(
			'https://platform.kimi.com/docs/overview', html, parseLlmsTxt(llms)
		).title).toBe('Kimi API 开放平台');
	});

	test('covers locale-specific and locale-neutral sections from one llms.txt index', () => {
		const manifest = buildGenericLlmsTxtManifest(
			'https://docs.bigmodel.cn/cn/guide/start/introduction',
			'<html lang="zh-CN"></html>',
			parseLlmsTxt(`# 智谱AI开放文档
- [平台介绍](https://docs.bigmodel.cn/cn/guide/start/introduction.md)
- [对话历史](https://docs.bigmodel.cn/api-reference/agent-api/history.md)
- [English](https://docs.bigmodel.cn/en/guide/start/introduction.md)`)
		);
		expect(manifest.rootUrl).toBe('https://docs.bigmodel.cn/');
		expect(manifest.pages.map(page => page.docname)).toEqual([
			'cn/guide/start/introduction',
			'api-reference/agent-api/history',
		]);
	});

	test('uses the visible documentation sidebar before path-order fallback', async () => {
		const html = `<html lang="zh-CN"><body>
			<a href="/llms.txt">Documentation Index</a>
			<nav aria-label="Pages"><ul>
				<li><a href="/cn/guide/start/introduction">平台介绍</a></li>
				<li><a href="/cn/guide/start/quick-start">快速开始</a></li>
			</ul></nav>
		</body></html>`;
		const llms = `# 智谱AI开放文档
- [API](https://docs.bigmodel.cn/cn/api/introduction.md)
- [平台介绍](https://docs.bigmodel.cn/cn/guide/start/introduction.md)
- [快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start.md)`;
		const manifest = await discoverDocumentation({
			currentUrl: 'https://docs.bigmodel.cn/cn/guide/start/introduction',
			currentHtml: html,
			fetchText: async () => ({ ok: true, status: 200, text: llms }),
			documentParser: { parseFromString: source => parseHTML(source).document },
		});
		expect(manifest.navigation?.[0]).toMatchObject({
			docname: 'guide/start/introduction', title: '平台介绍',
		});
		expect(manifest.navigation?.[manifest.navigation.length - 1]?.title).toBe('其他页面');
	});
});

describe('Google DevSite discovery', () => {
	test('parses sitemap locations and filters the Gemini docs root', () => {
		expect(parseSitemapLocations(`<?xml version="1.0"?>
			<urlset><url><loc>https://ai.google.dev/gemini-api/docs</loc></url>
			<url><loc>https://ai.google.dev/gemini-api/docs/text-generation</loc></url></urlset>`)
		).toHaveLength(2);

		const manifest = buildGoogleDevsiteManifest(
			'https://ai.google.dev/gemini-api/docs?hl=zh-cn',
			[
				'https://ai.google.dev/gemini-api/docs',
				'https://ai.google.dev/gemini-api/docs/text-generation',
				'https://ai.google.dev/gemini-api/docs/text-generation#duplicate',
				'https://ai.google.dev/api',
			]
		);

		expect(manifest.kind).toBe('google-devsite');
		expect(manifest.locale).toBe('zh-cn');
		expect(manifest.pages).toHaveLength(2);
		expect(manifest.pages[1].fetchUrl).toBe(
			'https://ai.google.dev/gemini-api/docs/text-generation?hl=zh-cn'
		);
	});

	test('follows sitemap index shards during discovery', async () => {
		const responses = new Map<string, string>([
			['https://ai.google.dev/sitemap.xml', `
				<sitemapindex>
					<sitemap><loc>https://ai.google.dev/sitemap_0.xml</loc></sitemap>
					<sitemap><loc>https://ai.google.dev/sitemap_1.xml</loc></sitemap>
				</sitemapindex>`],
			['https://ai.google.dev/sitemap_0.xml', `
				<urlset><url><loc>https://ai.google.dev/gemini-api/docs</loc></url></urlset>`],
			['https://ai.google.dev/sitemap_1.xml', `
				<urlset><url><loc>https://ai.google.dev/gemini-api/docs/models</loc></url></urlset>`],
		]);
		const manifest = await discoverDocumentation({
			currentUrl: 'https://ai.google.dev/gemini-api/docs',
			currentHtml: '<devsite-header></devsite-header>',
			fetchText: async url => ({
				ok: responses.has(url),
				status: responses.has(url) ? 200 : 404,
				text: responses.get(url) || '',
			}),
		});

		expect(manifest.pages.map(page => page.docname)).toEqual(['index', 'models']);
	});
});

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

	test('enforces the collection safety limit', () => {
		const docnames = Array.from({ length: 5001 }, (_, index) => `page-${index}`);
		expect(() => buildSphinxManifest(
			'https://docs.example.com/en/stable/',
			{ docnames, titles: docnames }
		)).toThrow(/5000/);
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

describe('parseDocumentationNavigation', () => {
	test('preserves visible sidebar section labels and localizes unmatched pages', () => {
		const manifest = buildGoogleDevsiteManifest(
			'https://ai.google.dev/gemini-api/docs?hl=zh-cn',
			[
				'https://ai.google.dev/gemini-api/docs',
				'https://ai.google.dev/gemini-api/docs/quickstart',
				'https://ai.google.dev/gemini-api/docs/models',
				'https://ai.google.dev/gemini-api/docs/changelog',
			]
		);
		const navigation = parseDocumentationNavigation({
			html: `<nav aria-label="侧边菜单"><ul>
				<li><span>开始使用</span><ul>
					<li><a href="/gemini-api/docs">概览</a></li>
					<li><a href="/gemini-api/docs/quickstart">快速开始</a></li>
				</ul></li>
				<li><span>模型</span><ul>
					<li><a href="/gemini-api/docs/models">所有模型</a></li>
				</ul></li>
			</ul></nav>`,
			pageUrl: 'https://ai.google.dev/gemini-api/docs?hl=zh-cn',
			manifest,
			documentParser: { parseFromString: html => parseHTML(html).document },
		});

		expect(navigation).toEqual([
			{
				title: '开始使用',
				children: [
					{ docname: 'index', title: '概览', children: [] },
					{ docname: 'quickstart', title: '快速开始', children: [] },
				],
			},
			{
				title: '模型',
				children: [{ docname: 'models', title: '所有模型', children: [] }],
			},
			{
				title: '其他页面',
				children: [{ docname: 'changelog', title: 'Changelog', children: [] }],
			},
		]);
	});
});

describe('documentation card grids', () => {
	test('restores card tokens after Markdown escapes their underscores', () => {
		const cards = encodeURIComponent(JSON.stringify([
			{ title: 'Gemini 3.1 Pro', description: '高性能模型', url: 'https://ai.google.dev/models/pro' },
			{ title: 'Gemini Flash', description: '高速模型', url: 'https://ai.google.dev/models/flash' },
		]));
		const restored = restoreDocumentationCardGrids(
			`OBSIDIAN\\_DOCUMENT\\_CARD\\_GRID\\_0\\_${cards}\\_END`
		);
		expect(restored).toContain('display:grid');
		expect(restored).toContain('Gemini 3.1 Pro');
		expect(restored).not.toContain('OBSIDIAN\\_DOCUMENT');
	});
});

describe('collectDocumentPages', () => {
	test('applies the active template to direct Markdown pages', async () => {
		const manifest = buildLlmsTxtManifest(
			'https://platform.claude.com/docs/en/intro',
			parseLlmsTxt('- [Intro](https://platform.claude.com/docs/en/intro.md)')
		);
		const pages = await collectDocumentPages({
			manifest,
			template: {
				id: 'default',
				name: 'Default',
				behavior: 'create',
				noteNameFormat: '{{title}}',
				path: 'Clippings',
				noteContentFormat: 'Source: {{url}}\n\n{{content}}',
				context: '',
				properties: [],
				triggers: [],
			},
			documentParser: { parseFromString: html => parseHTML(html).document },
			fetchText: async url => ({
				ok: url.endsWith('.md'),
				status: 200,
				text: '# Intro\n\nUse the Messages API.',
			}),
		});

		expect(pages[0].noteName).toBe('Intro');
		expect(pages[0].content).toContain('Use the Messages API.');
		expect(pages[0].content).toContain('https://platform.claude.com/docs/en/intro');
	});

	test('normalizes documentation titles, boilerplate, relative links and duplicate redirects', async () => {
		const manifest = buildGoogleDevsiteManifest(
			'https://ai.google.dev/gemini-api/docs?hl=zh-cn',
			[
				'https://ai.google.dev/gemini-api/docs/image-generation',
				'https://ai.google.dev/gemini-api/docs/nanobanana',
			]
		);
		const seenSourceUrls = new Set<string>();
		const pages = await collectDocumentPages({
			manifest,
			template: {
				id: 'default', name: 'Default', behavior: 'create',
				noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}',
				context: '', properties: [
					{ name: 'title', value: '{{title}}', type: 'text' },
					{ name: 'author', value: '{{author}}', type: 'text' },
				], triggers: [],
			},
			documentParser: { parseFromString: source => parseHTML(source).document },
			seenSourceUrls,
			fetchText: async () => ({
				ok: true,
				status: 200,
				finalUrl: 'https://ai.google.dev/gemini-api/docs/image-generation?hl=zh-cn',
				text: `<html><head><title>图片生成 | Gemini API</title></head><body><main>
					<h1>图片生成</h1><div class="gemini-api-recommended"><h2>认识这些模型</h2>
						<a class="gemini-api-card-overview" href="/models/pro"><p class="gemini-api-card-title">Pro <span>新</span></p><p class="gemini-api-card-description">高质量模型</p></a>
						<a class="gemini-api-card-overview" href="/models/flash"><p class="gemini-api-card-title">Flash</p><p class="gemini-api-card-description">高速模型</p></a>
					</div></main></body></html>`,
			}),
		});
		expect(pages).toHaveLength(1);
		expect(pages[0].title).toBe('图片生成');
		expect(pages[0].noteName).toBe('图片生成');
		expect(pages[0].content).not.toContain('author:');
		expect(pages[0].content).toContain('display:grid');
		expect(pages[0].content).toContain('## 认识这些模型');
		expect(pages[0].content).toContain('https://ai.google.dev/models/pro');
	});

	test('cleans llms.txt boilerplate and resolves relative Markdown links', async () => {
		const manifest = buildGenericLlmsTxtManifest(
			'https://docs.bigmodel.cn/cn/guide/start/introduction',
			'<html lang="zh-CN"></html>',
			parseLlmsTxt('- [快速开始](https://docs.bigmodel.cn/cn/api/introduction.md)')
		);
		const pages = await collectDocumentPages({
			manifest,
			template: {
				id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}',
				path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [],
			},
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async () => ({ ok: true, status: 200, text: `> ## Documentation Index
> Fetch the complete documentation index at: https://docs.bigmodel.cn/llms.txt
> Use this file to discover all available pages before exploring further.

# 快速开始

[SDKs](/cn/guide/develop/python/introduction)` }),
		});
		expect(pages[0].content).not.toContain('Documentation Index');
		expect(pages[0].content).toContain('(https://docs.bigmodel.cn/cn/guide/develop/python/introduction)');
	});

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

	test('accepts a root page URL without the normalized trailing slash', async () => {
		const manifest = buildGoogleDevsiteManifest(
			'https://ai.google.dev/gemini-api/docs',
			['https://ai.google.dev/gemini-api/docs']
		);
		await expect(collectDocumentPages({
			manifest,
			template: {
				id: 'default', name: 'Default', behavior: 'create',
				noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}',
				context: '', properties: [], triggers: [],
			},
			documentParser: { parseFromString: html => parseHTML(html).document },
			fetchText: async () => ({
				ok: true,
				status: 200,
				finalUrl: 'https://ai.google.dev/gemini-api/docs',
				text: '<html><head><title>Gemini API</title></head><body><main><h1>Gemini API</h1></main></body></html>',
			}),
		})).resolves.toHaveLength(1);
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
			'Docs/a/Same - other.md',
		]);
	});

	test('renders virtual navigation groups as section headings using sidebar labels', () => {
		const manifest = {
			kind: 'google-devsite' as const,
			title: 'Gemini API documentation - zh-cn',
			rootUrl: 'https://ai.google.dev/gemini-api/docs/',
			locale: 'zh-cn',
			pages: [
				{ docname: 'quickstart', title: 'Get Started', url: 'https://ai.google.dev/gemini-api/docs/quickstart' },
				{ docname: 'models', title: 'Models', url: 'https://ai.google.dev/gemini-api/docs/models' },
			],
			navigation: [
				{ title: '开始使用', children: [{ docname: 'quickstart', title: '快速开始', children: [] }] },
				{ title: '模型', children: [{ docname: 'models', title: '所有模型', children: [] }] },
			],
		};
		const output = buildDocumentBundleOutput({
			manifest,
			pages: [
				{ ...manifest.pages[0], title: '使用入门', noteName: '使用入门', content: '开始。' },
				{ ...manifest.pages[1], title: '模型', noteName: '模型', content: '模型。' },
			],
			basePath: '',
		});

		expect(output.indexContent).toContain('## 目录');
		expect(output.indexContent).toContain('## 开始使用\n\n- [[Gemini API documentation - zh-cn/开始使用/使用入门|快速开始]]');
		expect(output.indexContent).toContain('## 模型\n\n- [[Gemini API documentation - zh-cn/模型/模型|所有模型]]');
		expect(output.indexContent).not.toContain('- **开始使用**');
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

	test('builds stable partial batches and uses Companion-owned paths in the index', () => {
		const manifest = {
			kind: 'llms-txt' as const,
			title: 'Docs',
			rootUrl: 'https://example.com/docs/en/',
			pages: [
				{ docname: 'intro', title: 'Intro', url: 'https://example.com/docs/en/intro' },
				{ docname: 'guide', title: 'Guide', url: 'https://example.com/docs/en/guide' },
			],
		};
		const partial = buildDocumentBundleOutput({
			manifest,
			pages: [{ ...manifest.pages[1], noteName: 'Guide', content: '# Guide' }],
			basePath: '',
		});
		expect(partial.notes[0].sourceUrl).toBe('https://example.com/docs/en/guide');

		const index = buildDocumentBundleOutput({
			manifest,
			pages: manifest.pages.map(page => ({ ...page, noteName: page.title, content: '' })),
			basePath: '',
			pathOverrides: {
				intro: 'Docs/Intro-1.md',
				guide: 'Docs/Guide.md',
			},
		});
		expect(index.indexContent).toContain('[[Docs/Intro-1|Intro]]');
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
