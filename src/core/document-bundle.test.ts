import { describe, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';

import {
	buildDocumentBundleOutput,
	buildAliyunDocHelpManifest,
	buildClaudeSitemapManifest,
	buildDocusaurusManifest,
	buildInteractiveSidebarManifest,
	buildGenericLlmsTxtManifest,
	buildGoogleDevsiteManifest,
	buildHtmlSidebarManifest,
	buildVitePressManifest,
	buildLlmsTxtManifest,
	buildSphinxManifest,
	collectDocumentPages,
	detectDocumentSourceKind,
	discoverDocumentation,
	isLikelySphinxDocumentationHtml,
	normalizeDocumentationBody,
	normalizeMergedPageBody,
	parseLlmsTxt,
	parseDocumentationNavigation,
	parseSitemapLocations,
	parseSphinxNavigation,
	parseSphinxSearchIndex,
	preserveDocumentationCardGrids,
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
		expect(detectDocumentSourceKind(
			'https://www.openai-hk.com/docs/getting-started.html',
			'<script>window.__VP_SITE_DATA__=JSON.parse("{}")</script><div class="VPNavBar"></div>'
		)).toBe('vitepress');
		expect(detectDocumentSourceKind(
			'https://api-docs.siliconflow.cn/docs/userguide/introduction',
			'<aside id="nd-sidebar"><a href="/docs/userguide/introduction">Intro</a></aside>'
		)).toBe('sidebar-html');
		expect(detectDocumentSourceKind(
			'https://docs.xkiro.com/',
			'<aside class="thin-scroll"><a href="/guides/quickstart/">Quick start</a></aside>'
		)).toBe('sidebar-html');
		expect(detectDocumentSourceKind(
			'https://docs.openclaw.ai/zh-CN',
			'<body class="oc-app-surface"><aside class="sidebar"><a href="/zh-CN/install">安装</a></aside></body>'
		)).toBe('sidebar-html');
		expect(detectDocumentSourceKind(
			'https://developers.openai.com/api/docs',
			'<nav><a href="/api/docs/quickstart">Quickstart</a></nav>'
		)).toBe('sidebar-html');
		expect(detectDocumentSourceKind(
			'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api',
			'<div class="navList__abc"><div class="menuItem__abc">获取 API Key</div></div>'
		)).toBe('sidebar-html');
	});

	test.each([
		['MkDocs Material', 'https://docs.example.com/guide/', '<aside class="md-sidebar md-sidebar--primary"><nav class="md-nav"><a href="/guide/start/">Start</a></nav></aside>'],
		['Read the Docs', 'https://project.readthedocs.io/en/latest/', '<nav class="wy-nav-side"><div class="wy-menu-vertical"><a href="usage.html">Usage</a></div></nav>'],
		['GitBook', 'https://docs.example.com/', '<aside class="side-sheet group/table-of-contents"><a href="/getting-started">Getting started</a></aside>'],
		['Nextra', 'https://docs.example.com/docs/', '<aside class="nextra-sidebar"><a href="/docs/install">Install</a></aside>'],
		['Mintlify', 'https://docs.example.com/', '<aside data-component-part="sidebar"><a href="/quickstart">Quickstart</a></aside>'],
		['Docsify', 'https://docs.example.com/#/', '<script>window.$docsify={loadSidebar:true}</script><aside class="docsify-sidebar"><div class="sidebar-nav"><a href="#/guide">Guide</a></div></aside>'],
	])('detects %s through generic framework markers', (_name, url, html) => {
		expect(detectDocumentSourceKind(url, html)).toBe('sidebar-html');
	});
});

describe('Alibaba Bailian official documentation API', () => {
	const menuSource = JSON.stringify({
		code: '200',
		data: {
			Data: JSON.stringify({
				title: '大模型服务平台百炼',
				children: [
					{ title: '用户指南（模型）', url: '/zh/model-studio/model-user-guide/', children: [] },
					{ title: '用户指南（应用）', url: '/zh/model-studio/application-user-guide/', children: [] },
					{
						title: 'API参考（模型）', url: '/zh/model-studio/model-api-reference/', children: [
							{ title: '使用 API', children: [
								{ title: '获取 API Key', url: '/zh/model-studio/get-api-key', alias: '/model-studio/get-api-key', id: 1234567, validDocument: true },
								{ title: '目录节点', alias: '/model-studio/group', validDocument: false },
							] },
						],
					},
					{ title: 'API参考（应用）', url: '/zh/model-studio/application-api-reference/', children: [] },
				],
			}),
		},
	});

	test('selects the current API/model subtree and builds official content endpoints', () => {
		const manifest = buildAliyunDocHelpManifest(
			'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model&url=2712195',
			menuSource
		);
		expect(manifest).toMatchObject({
			kind: 'aliyun-dochelp',
			title: '阿里云百炼 · API参考（模型）',
			locale: 'zh-cn',
		});
		expect(manifest.pages).toHaveLength(1);
		expect(manifest.pages[0]).toMatchObject({
			docname: 'model-studio/get-api-key',
			url: 'https://help.aliyun.com/zh/model-studio/get-api-key',
			contentType: 'aliyun-json',
			aliyunNodeId: '1234567',
		});
		expect(manifest.pages[0].fetchUrl).toContain('document_detail.json?alias=%2Fmodel-studio%2Fget-api-key');
	});

	test('uses the official page URL when a new menu item exposes only a short alias', () => {
		const shortAliasMenu = JSON.stringify({
			code: '200',
			data: {
				Data: JSON.stringify({
					title: '大模型服务平台百炼',
					children: [
						{ title: '用户指南（模型）', children: [] },
						{ title: '用户指南（应用）', children: [] },
						{
							title: 'API参考（模型）',
							url: '/zh/model-studio/model-api-reference/',
							children: [{
								title: '客户端事件',
								url: '/zh/model-studio/client-events',
								alias: '/client-events',
								validDocument: true,
							}],
						},
						{ title: 'API参考（应用）', children: [] },
					],
				}),
			},
		});

		const manifest = buildAliyunDocHelpManifest(
			'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model',
			shortAliasMenu
		);

		expect(manifest.pages[0]).toMatchObject({
			docname: 'model-studio/client-events',
			url: 'https://help.aliyun.com/zh/model-studio/client-events',
		});
		expect(manifest.pages[0].fetchUrl).toContain(
			'alias=%2Fmodel-studio%2Fclient-events'
		);
		expect(manifest.navigation?.[0].children[0]).toMatchObject({
			title: '客户端事件',
			docname: 'model-studio/client-events',
		});
	});

	test('collects HTML from the official document detail JSON response', async () => {
		const manifest = buildAliyunDocHelpManifest(
			'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model',
			menuSource
		);
		const pages = await collectDocumentPages({
			manifest,
			template: { id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [] },
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async url => ({
				ok: true, status: 200, finalUrl: url,
				text: JSON.stringify({ data: { title: '获取 API Key', content: '<article><h1>获取 API Key</h1><p>创建并保存密钥。</p></article>' } }),
			}),
		});
		expect(pages).toHaveLength(1);
		expect(pages[0].url).toBe('https://help.aliyun.com/zh/model-studio/get-api-key');
		expect(pages[0].body).toContain('创建并保存密钥。');
	});

	test('retries a transient successful response with empty document content', async () => {
		const manifest = buildAliyunDocHelpManifest(
			'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model',
			menuSource
		);
		let requests = 0;
		const requestedUrls: string[] = [];
		const pages = await collectDocumentPages({
			manifest,
			template: { id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [] },
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async url => {
				requests += 1;
				requestedUrls.push(url);
				return {
					ok: true, status: 200, finalUrl: url,
					text: JSON.stringify({ data: requests === 1
						? { title: '获取 API Key', content: '' }
						: { title: '获取 API Key', content: '<h1>获取 API Key</h1><p>重试后取得正文。</p>' } }),
				};
			},
		});
		expect(requests).toBe(2);
		expect(requestedUrls[1]).toContain('_clipper_retry=');
		expect(requestedUrls[1]).not.toBe(requestedUrls[0]);
		expect(pages[0].body).toContain('重试后取得正文。');
	});

	test('uses the document nodeId endpoint after repeated empty alias responses', async () => {
		vi.useFakeTimers();
		try {
			const manifest = buildAliyunDocHelpManifest(
				'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model',
				menuSource
			);
			let aliasRequests = 0;
			let nodeIdRequests = 0;
			const collection = collectDocumentPages({
				manifest,
				template: { id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [] },
				documentParser: { parseFromString: source => parseHTML(source).document },
				fetchText: async url => {
					if (url.includes('nodeId=1234567')) {
						nodeIdRequests += 1;
						return {
							ok: true,
							status: 200,
							finalUrl: url,
							text: JSON.stringify({ data: { title: '获取 API Key', content: '<h1>获取 API Key</h1><p>nodeId 兜底正文。</p>' } }),
						};
					}
					aliasRequests += 1;
					return {
						ok: true,
						status: 200,
						finalUrl: url,
						text: JSON.stringify({ code: 200, success: true, data: { title: '获取 API Key', content: '' } }),
					};
				},
			});
			await vi.runAllTimersAsync();
			const pages = await collection;
			expect(aliasRequests).toBe(4);
			expect(nodeIdRequests).toBe(1);
			expect(pages[0].body).toContain('nodeId 兜底正文。');
		} finally {
			vi.useRealTimers();
		}
	});

	test('retries the public HTML page after alias and nodeId responses stay empty', async () => {
		vi.useFakeTimers();
		try {
			const manifest = buildAliyunDocHelpManifest(
				'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model',
				menuSource
			);
			let jsonRequests = 0;
			let publicPageRequests = 0;
			const publicPageUrls: string[] = [];
			const collection = collectDocumentPages({
				manifest,
				template: { id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [] },
				documentParser: { parseFromString: source => parseHTML(source).document },
				fetchText: async url => {
					if (url.includes('document_detail.json')) {
						jsonRequests += 1;
						return {
							ok: true,
							status: 200,
							finalUrl: url,
							text: JSON.stringify({ code: 200, success: true, data: { title: '获取 API Key', content: '' } }),
						};
					}
					publicPageRequests += 1;
					publicPageUrls.push(url);
					return {
						ok: true,
						status: 200,
						finalUrl: url,
						text: publicPageRequests === 1
							? '<!doctype html><html><body>临时空页面</body></html>'
							: '<!doctype html><html><head><title>获取 API Key</title></head><body><main class="icms-help-docs-content"><h1>获取 API Key</h1><p>公开页面兜底正文。</p></main></body></html>',
					};
				},
			});
			await vi.runAllTimersAsync();
			const pages = await collection;
			expect(jsonRequests).toBe(7);
			expect(publicPageRequests).toBe(2);
			expect(publicPageUrls[1]).toContain('_clipper_fallback=');
			expect(pages[0].body).toContain('公开页面兜底正文。');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('VitePress documentation discovery', () => {
	test('uses the current locale sidebar and resolves the VitePress base path', () => {
		const html = `<html lang="zh-CN"><head><title>快速接入 | OpenAi-HK</title></head>
			<script>window.__VP_SITE_DATA__=JSON.parse("{\\"base\\":\\"/docs/\\",\\"themeConfig\\":{\\"sidebar\\":[{\\"text\\":\\"OpenAI ChatGPT\\",\\"items\\":[{\\"text\\":\\"快速接入\\",\\"link\\":\\"/getting-started\\"},{\\"text\\":\\"服务定价\\",\\"link\\":\\"/price\\"},{\\"text\\":\\"外部页面\\",\\"link\\":\\"https://example.com/nope\\"}]}]}}")</script>`;
		const manifest = buildVitePressManifest(
			'https://www.openai-hk.com/docs/getting-started.html',
			html
		);

		expect(manifest).toMatchObject({
			kind: 'vitepress',
			title: 'OpenAi-HK - zh-CN',
			locale: 'zh-cn',
			rootUrl: 'https://www.openai-hk.com/docs/',
		});
		expect(manifest.pages.map(page => page.url)).toEqual([
			'https://www.openai-hk.com/docs/getting-started.html',
			'https://www.openai-hk.com/docs/price.html',
		]);
		expect(manifest.navigation?.[0]).toMatchObject({
			title: 'OpenAI ChatGPT',
			children: [{ docname: 'getting-started', title: '快速接入' }, { docname: 'price', title: '服务定价' }],
		});
	});

	test('discovers VitePress through the shared adapter', async () => {
		const html = '<html lang="zh-CN"><script>window.__VP_SITE_DATA__=JSON.parse("{\\"base\\":\\"/docs/\\",\\"themeConfig\\":{\\"sidebar\\":[{\\"text\\":\\"Docs\\",\\"items\\":[{\\"text\\":\\"Start\\",\\"link\\":\\"/start\\"}]}]}}")</script></html>';
		const manifest = await discoverDocumentation({
			currentUrl: 'https://docs.example.com/docs/start.html',
			currentHtml: html,
			fetchText: async () => ({ ok: false, status: 404, text: '' }),
		});
		expect(manifest.kind).toBe('vitepress');
		expect(manifest.pages[0].url).toBe('https://docs.example.com/docs/start.html');
	});

	test('falls back to the cleaned VitePress sidebar after scripts are removed', async () => {
		const html = `<html lang="zh-CN"><head><title>快速接入 | OpenAi-HK</title></head><body>
			<header class="VPNavBar"></header><aside class="VPSidebar"><nav>
				<ul><li><a href="https://www.openai-hk.com/docs/getting-started.html">✅ 快速接入</a></li>
				<li><a href="https://www.openai-hk.com/docs/price.html">😊 服务定价</a></li></ul>
			</nav></aside></body></html>`;
		const manifest = await discoverDocumentation({
			currentUrl: 'https://www.openai-hk.com/docs/getting-started.html',
			currentHtml: html,
			fetchText: async () => ({ ok: false, status: 404, text: '' }),
			documentParser: { parseFromString: source => parseHTML(source).document },
		});
		expect(manifest).toMatchObject({
			kind: 'vitepress',
			title: 'OpenAi-HK - zh-CN',
			rootUrl: 'https://www.openai-hk.com/docs/',
		});
		expect(manifest.pages.map(page => page.docname)).toEqual(['getting-started', 'price']);
		expect(manifest.navigation?.[0]).toMatchObject({ title: '✅ 快速接入', docname: 'getting-started' });
	});
});

describe('official HTML sidebar discovery', () => {
	test('collects same-origin pages from supported documentation sidebars', () => {
		const manifest = buildHtmlSidebarManifest(
			'https://api-docs.siliconflow.cn/docs/userguide/introduction',
			`<html lang="zh-CN"><head><title>平台简介</title></head><body>
				<aside id="nd-sidebar"><nav><a href="/docs/userguide/introduction">平台简介</a>
				<a href="/docs/userguide/quickstart">快速上手</a>
				<a href="/docs/api-reference/models">模型列表</a>
				<a href="/docs/api/batches-%7Bbatch_id%7D-get">获取批处理</a>
				<a href="/docs/api/batches-%7Bbatch_id%7D-cancel-post">取消批处理</a>
				<a href="https://example.com/outside">外部页面</a></nav></aside>
			</body></html>`,
			{ parseFromString: source => parseHTML(source).document }
		);
		expect(manifest).toMatchObject({
			kind: 'sidebar-html',
			title: 'SiliconFlow API Documentation',
			locale: 'zh-cn',
			rootUrl: 'https://api-docs.siliconflow.cn/docs/',
		});
		expect(manifest.pages.map(page => page.url)).toEqual([
			'https://api-docs.siliconflow.cn/docs/userguide/introduction',
			'https://api-docs.siliconflow.cn/docs/userguide/quickstart',
			'https://api-docs.siliconflow.cn/docs/api-reference/models',
			'https://api-docs.siliconflow.cn/docs/api/batches-%7Bbatch_id%7D-get',
			'https://api-docs.siliconflow.cn/docs/api/batches-%7Bbatch_id%7D-cancel-post',
		]);
		expect(manifest.pages.slice(-2).map(page => page.docname)).toEqual([
			'api/batches-batch_id-get',
			'api/batches-batch_id-cancel-post',
		]);
	});

	test('recognizes xKiro and uses its site-level documentation title', () => {
		const html = `<html lang="en"><head>
			<title>xKiro API Documentation</title>
			<meta name="application-name" content="xKiro Docs">
			<meta property="og:site_name" content="xKiro Docs">
			</head><body><aside class="thin-scroll"><nav>
			<a href="/guides/quickstart/">Quickstart</a>
			<a href="/api/reference/">API Reference</a>
			</nav></aside></body></html>`;
		expect(detectDocumentSourceKind('https://docs.xkiro.com/', html)).toBe('sidebar-html');
		const manifest = buildHtmlSidebarManifest(
			'https://docs.xkiro.com/',
			html,
			{ parseFromString: source => parseHTML(source).document }
		);
		expect(manifest).toMatchObject({
			kind: 'sidebar-html',
			title: 'xKiro API Documentation',
			locale: 'en',
			rootUrl: 'https://docs.xkiro.com/',
		});
		expect(manifest.pages.map(page => page.docname)).toEqual([
			'guides/quickstart',
			'api/reference',
		]);
	});

	test('keeps OpenClaw locale root and trailing-slash URLs', () => {
		const manifest = buildHtmlSidebarManifest(
			'https://docs.openclaw.ai/zh-CN',
			`<html lang="zh-CN"><body class="oc-app-surface"><aside class="sidebar"><nav>
				<a href="/zh-CN/start/showcase">展示案例</a><a href="/zh-CN/install">安装</a>
			</nav></aside></body></html>`,
			{ parseFromString: source => parseHTML(source).document }
		);
		expect(manifest.rootUrl).toBe('https://docs.openclaw.ai/zh-CN/');
		expect(manifest.pages.map(page => page.docname)).toEqual(['start/showcase', 'install']);
	});

	test('keeps a client-rendered single-page documentation shell when its menu has no URLs', () => {
		const manifest = buildHtmlSidebarManifest(
			'https://platform.sensenova.cn/docs',
			'<html><head><title>SenseNova 文档</title></head><body><aside><button>概览</button><button>快速开始</button></aside><main><h1>SenseNova AI API 文档</h1></main></body></html>',
			{ parseFromString: source => parseHTML(source).document },
		);
		expect(manifest.pages).toHaveLength(1);
		expect(manifest.pages[0]).toMatchObject({ docname: 'index', contentType: 'html' });
	});

	test('uses the official sitemap for a locale-root documentation site', async () => {
		const sitemap = `<urlset>
			<url><loc>https://docs.openclaw.ai/</loc></url>
			<url><loc>https://docs.openclaw.ai/start/getting-started</loc></url>
			<url><loc>https://docs.openclaw.ai/zh-CN</loc></url>
			<url><loc>https://docs.openclaw.ai/zh-CN/start/getting-started</loc></url>
			<url><loc>https://docs.openclaw.ai/zh-CN/gateway/configuration</loc></url>
			<url><loc>https://docs.openclaw.ai/ja-JP/start/getting-started</loc></url>
		</urlset>`;
		const manifest = await discoverDocumentation({
			currentUrl: 'https://docs.openclaw.ai/zh-CN/start/getting-started',
			currentHtml: '<html lang="zh-CN"><head><title>OpenClaw Docs</title></head><body><aside class="sidebar"><a href="/zh-CN/start/getting-started">开始</a></aside></body></html>',
			fetchText: async url => ({ ok: url.endsWith('/sitemap.xml'), status: 200, text: sitemap }),
			documentParser: { parseFromString: source => parseHTML(source).document },
		});
		expect(manifest).toMatchObject({ kind: 'sitemap', locale: 'zh-CN', rootUrl: 'https://docs.openclaw.ai/zh-CN/' });
		expect(manifest.pages.map(page => page.docname)).toEqual([
			'index', 'gateway/configuration', 'start/getting-started',
		]);
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
		expect(manifest).toMatchObject({
			kind: 'docusaurus',
			title: 'DeepSeek API Docs - zh-CN',
			locale: 'zh-cn',
		});
		expect(manifest.pages.map(page => page.url)).toEqual([
			'https://api-docs.deepseek.com/zh-cn/',
			'https://api-docs.deepseek.com/zh-cn/guides/tool_calls',
		]);
	});

	test('limits a Docusaurus sitemap to the current docs root', () => {
		const manifest = buildDocusaurusManifest(
			'https://joycode.jd.com/docs/start/product-overview/',
			'<html lang="en"><head><title>产品概览 | JoyCode</title><meta name="generator" content="Docusaurus v3.0.0"></head></html>',
			[
				'https://joycode.jd.com/',
				'https://joycode.jd.com/docs/start/product-overview',
				'https://joycode.jd.com/docs/start/getting-started',
				'https://joycode.jd.com/docs/changelog',
				'https://joycode.jd.com/docs/tags',
				'https://joycode.jd.com/accountCenter/account',
			]
		);
		expect(manifest).toMatchObject({
			title: 'JoyCode',
			rootUrl: 'https://joycode.jd.com/docs/',
		});
		expect(manifest.pages.map(page => page.url)).toEqual([
			'https://joycode.jd.com/docs/changelog',
			'https://joycode.jd.com/docs/start/getting-started',
			'https://joycode.jd.com/docs/start/product-overview',
		]);
		expect(manifest.pages[0]).toMatchObject({
			contentType: 'joycode-changelog-json',
			fetchUrl: 'https://joycode.jd.com/api/saas/ideVersion/v1/ideVersionList',
			fetchOptions: { method: 'POST' },
		});
	});

	test('converts the official JoyCode changelog response into document content', async () => {
		const manifest = buildDocusaurusManifest(
			'https://joycode.jd.com/docs/start/product-overview/',
			'<html lang="en"><head><title>产品概览 | JoyCode</title><meta name="generator" content="Docusaurus"></head></html>',
			['https://joycode.jd.com/docs/changelog']
		);
		let requestOptions: RequestInit | undefined;
		const pages = await collectDocumentPages({
			manifest,
			template: { id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [] },
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async (url, options) => {
				requestOptions = options;
				return {
					ok: true, status: 200, finalUrl: url,
					text: JSON.stringify({ code: 0, data: [{ semver: '3.0.9', publishedAt: 1785168000000, releaseNotes: '<p>提升系统稳定性。</p>' }] }),
				};
			},
		});
		expect(requestOptions).toMatchObject({ method: 'POST', body: '{"pluginId":"joycoder-ide","plat":"IDE"}' });
		expect(pages[0].body).toContain('v3.0.9');
		expect(pages[0].body).toContain('提升系统稳定性。');
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

	test('uses the page-level site title when a generic llms.txt heading is incomplete', () => {
		const manifest = buildGenericLlmsTxtManifest(
			'https://fal.ai/docs/documentation',
			'<html lang="en"><head><title>fal Docs</title><meta property="og:site_name" content="fal"></head></html>',
			parseLlmsTxt('# fal\n\n- [Overview](https://fal.ai/docs/documentation.md)')
		);
		expect(manifest.title).toBe('fal Docs');
		expect(manifest.rootUrl).toBe('https://fal.ai/docs/');
	});

	test('recursively expands same-origin llms.txt indexes and keeps HTML pages', async () => {
		const root = `# OpenAI Developers
- [Codex index](https://developers.openai.com/codex/llms.txt)
- [Quickstart](https://developers.openai.com/api/docs/quickstart.md)`;
		const codex = `# Codex
- [Configuration](https://developers.openai.com/codex/config.md)
- [Showcase](https://developers.openai.com/codex/showcase)`;
		const manifest = await discoverDocumentation({
			currentUrl: 'https://developers.openai.com/api/docs',
			currentHtml: '<html lang="en"><a href="/llms.txt">Documentation index</a></html>',
			fetchText: async url => ({
				ok: true, status: 200, text: url.includes('/codex/llms.txt') ? codex : root,
			}),
		});
		expect(manifest.pages.map(page => [page.docname, page.contentType])).toEqual([
			['api/docs/quickstart', 'markdown'],
			['codex/config', 'markdown'],
			['codex/showcase', 'html'],
		]);
	});

	test('uses the site root when llms.txt spans multiple documentation roots', () => {
		const manifest = buildGenericLlmsTxtManifest(
			'https://developers.openai.com/api/docs',
			'<html lang="en"></html>',
			parseLlmsTxt(`# OpenAI Developers
- [API](https://developers.openai.com/api/docs/quickstart.md)
- [Codex](https://developers.openai.com/codex/cli-customization.md)`)
		);
		expect(manifest.rootUrl).toBe('https://developers.openai.com/');
		expect(manifest.pages.map(page => page.fetchUrl)).toEqual([
			'https://developers.openai.com/api/docs/quickstart.md',
			'https://developers.openai.com/codex/cli-customization.md',
		]);
	});

	test('allows same-origin Markdown pages from mixed official documentation roots', async () => {
		await expect(collectDocumentPages({
			manifest: {
				kind: 'llms-txt-generic', title: 'OpenAI Developers', rootUrl: 'https://developers.openai.com/api/', locale: 'en',
				pages: [{
					docname: 'codex/cli-customization',
					title: 'Codex CLI customization',
					url: 'https://developers.openai.com/codex/cli-customization',
					fetchUrl: 'https://developers.openai.com/codex/cli-customization.md',
					contentType: 'markdown',
				}],
			},
			template: {
				id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}',
				path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [],
			},
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async () => ({ ok: true, status: 200, finalUrl: 'https://developers.openai.com/codex/cli-customization', text: '# Codex CLI customization\n\nUse the CLI.' }),
		})).resolves.toHaveLength(1);
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
		expect(manifest.title).toBe('Gemini API Documentation - zh-CN');
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

	test.each([
		['MkDocs Material', '<aside class="md-sidebar md-sidebar--primary"><nav class="md-nav"><ul><li><span>Guide</span><ul><li><a href="/docs/start">Start</a></li><li><a href="/docs/install">Install</a></li></ul></li></ul></nav></aside>'],
		['Read the Docs', '<nav class="wy-nav-side"><div class="wy-menu-vertical"><ul><li><span>Guide</span><ul><li><a href="/docs/start">Start</a></li><li><a href="/docs/install">Install</a></li></ul></li></ul></div></nav>'],
		['GitBook', '<aside class="side-sheet group/table-of-contents"><ul><li><span>Guide</span><ul><li><a href="/docs/start">Start</a></li><li><a href="/docs/install">Install</a></li></ul></li></ul></aside>'],
		['Nextra', '<aside class="nextra-sidebar"><ul><li><span>Guide</span><ul><li><a href="/docs/start">Start</a></li><li><a href="/docs/install">Install</a></li></ul></li></ul></aside>'],
		['Mintlify', '<aside data-component-part="sidebar"><ul><li><span>Guide</span><ul><li><a href="/docs/start">Start</a></li><li><a href="/docs/install">Install</a></li></ul></li></ul></aside>'],
		['Docsify', '<aside class="docsify-sidebar"><div class="sidebar-nav"><ul><li><span>Guide</span><ul><li><a href="/docs/start">Start</a></li><li><a href="/docs/install">Install</a></li></ul></li></ul></div></aside>'],
	])('preserves nested sidebar hierarchy for %s', (_name, html) => {
		const manifest = {
			kind: 'sidebar-html' as const,
			title: 'Example Docs',
			rootUrl: 'https://docs.example.com/docs/',
			locale: 'en',
			pages: [
				{ docname: 'start', title: 'Start', url: 'https://docs.example.com/docs/start' },
				{ docname: 'install', title: 'Install', url: 'https://docs.example.com/docs/install' },
			],
		};
		const navigation = parseDocumentationNavigation({
			html,
			pageUrl: 'https://docs.example.com/docs/start',
			manifest,
			documentParser: { parseFromString: source => parseHTML(source).document },
		});
		expect(navigation).toEqual([{
			title: 'Guide',
			children: [
				{ docname: 'start', title: 'Start', children: [] },
				{ docname: 'install', title: 'Install', children: [] },
			],
		}]);
	});

	test('preserves Docsify hash routes as separate pages', () => {
		const manifest = buildHtmlSidebarManifest(
			'https://docsify.js.org/#/',
			`<html><head><title>docsify</title><script>window.$docsify = {}</script></head><body>
				<nav class="sidebar-nav"><ul>
					<li><a href="#/">Introduction</a></li>
					<li><a href="#/quickstart">Quick start</a></li>
					<li><a href="#/configuration">Configuration</a></li>
				</ul></nav>
			</body></html>`,
			{ parseFromString: source => parseHTML(source).document }
		);
		expect(manifest.pages.map(page => page.docname)).toEqual(['index', 'quickstart', 'configuration']);
		expect(manifest.pages.map(page => page.url)).toEqual([
			'https://docsify.js.org/#/',
			'https://docsify.js.org/#/quickstart',
			'https://docsify.js.org/#/configuration',
		]);
	});

	test('uses DOM anchor order when a documentation sidebar has no list markup', () => {
		const manifest = {
			kind: 'sidebar-html' as const,
			title: 'SiliconFlow API Documentation',
			rootUrl: 'https://api-docs.siliconflow.cn/docs/',
			locale: 'zh-cn',
			pages: [
				{ docname: 'userguide/introduction', title: '平台简介', url: 'https://api-docs.siliconflow.cn/docs/userguide/introduction' },
				{ docname: 'userguide/quickstart', title: '快速上手', url: 'https://api-docs.siliconflow.cn/docs/userguide/quickstart' },
				{ docname: 'userguide/capabilities/text-generation', title: '开始使用', url: 'https://api-docs.siliconflow.cn/docs/userguide/capabilities/text-generation' },
			],
		};
		const navigation = parseDocumentationNavigation({
			html: `<aside><nav>
				<div><a href="/docs/userguide/quickstart">快速上手</a></div>
				<div><a href="/docs/userguide/introduction">平台简介</a></div>
				<div><a href="/docs/userguide/capabilities/text-generation">开始使用</a></div>
			</nav></aside>`,
			pageUrl: 'https://api-docs.siliconflow.cn/docs/userguide/quickstart',
			manifest,
			documentParser: { parseFromString: source => parseHTML(source).document },
		});

		expect(navigation[0].title).toBe('userguide');
		expect(navigation[0].children.map(node => node.docname || node.title)).toEqual([
			'userguide/quickstart',
			'userguide/introduction',
			'capabilities',
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

describe('documentation Markdown cleanup', () => {
	test('repairs joined fences, heading escapes, list indentation, and orphan emphasis', () => {
		const cleaned = normalizeDocumentationBody(
			'## 1\\. Start\n\n**\n\n<table><tr><td>A</td></tr></table>\n\n**\n\n```\ncode\n```[Next](https://example.com/next)\n\n\t- child'
		);
		expect(cleaned).toContain('## 1. Start');
		expect(cleaned).not.toContain('\n**\n');
		expect(cleaned).toContain('```\n\n[Next](https://example.com/next)');
		expect(cleaned).toContain('  - child');
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

	test('restores callout structure and removes previous/next navigation cards from HTML docs', () => {
		const prepared = preserveDocumentationCardGrids(
			`<html lang="zh-CN"><head><title>指南</title></head><body><article>
				<h1>指南</h1><p>正文。</p>
				<div class="note note-important"><div class="noteContentSpan"><strong>重要</strong><p>请妥善保存密钥。</p></div></div>
				<div class="@container grid gap-4 pb-6 grid-cols-2">
					<a href="/docs/previous">上一篇说明</a><a href="/docs/next">下一篇说明</a>
				</div>
			</article></body></html>`,
			'https://docs.example.com/docs/guide',
			{ parseFromString: source => parseHTML(source).document }
		);
		const document = parseHTML(prepared).document;
		const callout = document.querySelector('blockquote');
		expect(callout?.textContent).toContain('[!IMPORTANT] 重要');
		expect(callout?.textContent).toContain('请妥善保存密钥。');
		expect(document.body.textContent).not.toContain('上一篇说明');
		expect(document.body.textContent).not.toContain('下一篇说明');
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

	test('allows the official OpenAI documentation mirror redirect', async () => {
		await expect(collectDocumentPages({
			manifest: {
				kind: 'sidebar-html', title: 'OpenAI Developers', rootUrl: 'https://developers.openai.com/api/docs/', locale: 'en',
				pages: [{ docname: 'codex/config-file/config-reference', title: 'Config reference', url: 'https://developers.openai.com/codex/config-file/config-reference.md', contentType: 'markdown' }],
			},
			template: { id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [] },
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async () => ({ ok: true, status: 200, finalUrl: 'https://learn.chatgpt.com/docs/config-file/config-reference.md', text: '# Config reference\n\nUse the configuration file.' }),
		})).resolves.toHaveLength(1);
	});

	test('allows JoyCode to normalize HTTPS pages to HTTP on the same host', async () => {
		await expect(collectDocumentPages({
			manifest: {
				kind: 'docusaurus', title: 'JoyCode', rootUrl: 'https://joycode.jd.com/docs/', locale: 'en',
				pages: [{ docname: 'case/case1', title: '案例', url: 'https://joycode.jd.com/docs/case/case1', contentType: 'html' }],
			},
			template: { id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}', path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [] },
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async () => ({ ok: true, status: 200, finalUrl: 'http://joycode.jd.com/docs/case/case1/', text: '<html><head><title>案例</title></head><body><h1>案例</h1></body></html>' }),
		})).resolves.toHaveLength(1);
	});

	test('builds chapter pages from an interactive documentation menu', () => {
		const manifest = buildInteractiveSidebarManifest(
			'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api',
			'<html><head><title>百炼 API 参考</title></head></html>',
			[
				{ url: 'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model&url=2712195', title: '获取 API Key', html: '<html></html>' },
				{ url: 'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model&url=2712193', title: '安装 SDK', html: '<html></html>' },
			]
		);
		expect(manifest.pages).toHaveLength(2);
		expect(manifest.pages[0].title).toBe('获取 API Key');
	});

	test('splits SenseNova sections in sidebar order and preserves section groups', async () => {
		const snapshots = [
			{
				url: 'https://platform.sensenova.cn/docs#overview',
				title: 'SenseNova AI API 文档',
				group: '入门',
				html: '<html lang="zh-CN"><head><title>SenseNova AI API 文档</title></head><body><main><h1>SenseNova AI API 文档</h1><p>概览正文</p></main></body></html>',
			},
			{
				url: 'https://platform.sensenova.cn/docs#quickstart',
				title: '快速开始',
				group: '入门',
				html: '<html lang="zh-CN"><head><title>快速开始</title></head><body><main><h1>快速开始</h1><p>快速开始正文</p></main></body></html>',
			},
			{
				url: 'https://platform.sensenova.cn/docs#model-flash',
				title: 'SenseNova 6.7 Flash-Lite',
				group: '模型',
				html: '<html lang="zh-CN"><head><title>SenseNova 6.7 Flash-Lite</title></head><body><main><h1>SenseNova 6.7 Flash-Lite</h1><p>模型正文</p></main></body></html>',
			},
		];
		const manifest = buildInteractiveSidebarManifest(
			'https://platform.sensenova.cn/docs',
			'<html lang="zh-CN"><head><title>SenseNova · LLM API 服务平台</title></head></html>',
			snapshots
		);
		expect(manifest.rootUrl).toBe('https://platform.sensenova.cn/');
		expect(manifest.pages).toHaveLength(3);
		expect(manifest.navigation).toEqual([
			{
				title: '入门',
				children: [
					{ docname: 'docs-overview', title: 'SenseNova AI API 文档', children: [] },
					{ docname: 'docs-quickstart', title: '快速开始', children: [] },
				],
			},
			{
				title: '模型',
				children: [
					{ docname: 'docs-model-flash', title: 'SenseNova 6.7 Flash-Lite', children: [] },
				],
			},
		]);

		const pages = await collectDocumentPages({
			manifest,
			template: {
				id: 'default', name: 'Default', behavior: 'create', noteNameFormat: '{{title}}',
				path: '', noteContentFormat: '{{content}}', context: '', properties: [], triggers: [],
			},
			documentParser: { parseFromString: source => parseHTML(source).document },
			fetchText: async () => ({ ok: false, status: 500, text: '' }),
			pageSnapshots: new Map(snapshots.map(snapshot => [snapshot.url, snapshot.html])),
			seenSourceUrls: new Set<string>(),
		});
		expect(pages.map(page => page.title)).toEqual([
			'SenseNova AI API 文档',
			'快速开始',
			'SenseNova 6.7 Flash-Lite',
		]);
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
			'Reference/Example docs/01 - Example docs.md',
			'Reference/Example docs/02 - guide/01 - Install.md',
			'Reference/Example docs/00 - Documentation index.md',
		]);
		expect(output.indexContent).toContain('[[Reference/Example docs/02 - guide/01 - Install|Install]]');
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
			'Docs/01 - a/01 - Same.md',
			'Docs/01 - a/02 - Same.md',
		]);
	});

	test('renders virtual navigation groups as section headings using sidebar labels', () => {
		const manifest = {
			kind: 'google-devsite' as const,
			title: 'Gemini API Documentation - zh-CN',
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
		expect(output.indexContent).toContain('## 开始使用\n\n- [[Gemini API Documentation - zh-CN/01 - 开始使用/01 - 使用入门|快速开始]]');
		expect(output.indexContent).toContain('## 模型\n\n- [[Gemini API Documentation - zh-CN/02 - 模型/01 - 模型|所有模型]]');
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

		expect(output.indexContent).toContain('- [[Docs/01 - Guide|Guide]]\n  - [[Docs/01 - Guide/01 - Install|Install]]');
		expect(output.notes.slice(0, 2).map(note => note.path)).toEqual([
			'Docs/01 - Guide.md',
			'Docs/01 - Guide/01 - Install.md',
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
