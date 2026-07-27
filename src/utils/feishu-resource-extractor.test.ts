// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	sendMessage: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
	runtime: {
		sendMessage: mocks.sendMessage,
	},
}));

import { extractFeishuStructuredContent } from './feishu-extractor';

function createDocument(url: string, title: string): Document {
	return {
		URL: url,
		title,
	} as Document;
}

function createHtmlDocument(url: string, title: string): Document {
	const doc = document.implementation.createHTMLDocument(title);
	Object.defineProperty(doc, 'URL', { value: url });
	return doc;
}

describe('Feishu complex resource extraction', () => {
	beforeEach(() => {
		mocks.sendMessage.mockReset();
	});

	test('extracts a direct electronic spreadsheet as a bounded readable preview', async () => {
		mocks.sendMessage.mockImplementation(async (request: { url?: string }) => {
			if (request.url?.endsWith('/sheets/query')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							sheets: [{
								sheet_id: 'sheet-1',
								title: '汇总',
								grid_properties: { row_count: 500, column_count: 40 },
							}],
						},
					},
				};
			}
			if (request.url?.includes('/values/')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							valueRange: {
								values: [['项目', '金额'], ['服务器', 1200]],
							},
						},
					},
				};
			}
			throw new Error(`Unexpected URL: ${request.url}`);
		});

		const result = await extractFeishuStructuredContent(createDocument(
			'https://example.feishu.cn/sheets/sht-token?sheet=sheet-1',
			'年度预算'
		));

		expect(result?.title).toBe('年度预算');
		expect(result?.content).toMatch(/<h2\b[^>]*>汇总<\/h2>/);
		expect(result?.content).toContain('服务器');
		expect(result?.content).toContain('预览已截断');
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
	});

	test('resolves a Wiki Bitable node and extracts fields and records', async () => {
		mocks.sendMessage.mockImplementation(async (request: { url?: string }) => {
			if (request.url?.includes('/wiki/v2/spaces/get_node')) {
				return {
					success: true,
					data: { code: 0, data: { node: { obj_token: 'base-token', obj_type: 'bitable' } } },
				};
			}
			if (request.url?.endsWith('/bitable/v1/apps/base-token')) {
				return {
					success: true,
					data: { code: 0, data: { app: { name: '项目库' } } },
				};
			}
			if (request.url?.includes('/tables?page_size=')) {
				return {
					success: true,
					data: { code: 0, data: { items: [{ table_id: 'tbl1', name: '任务' }] } },
				};
			}
			if (request.url?.includes('/fields?page_size=')) {
				return {
					success: true,
					data: { code: 0, data: { items: [{ field_name: '名称' }, { field_name: '负责人' }] } },
				};
			}
			if (request.url?.includes('/records?page_size=')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							items: [{ fields: { 名称: [{ text: '发布版本' }], 负责人: [{ name: '小明' }] } }],
							total: 1,
						},
					},
				};
			}
			throw new Error(`Unexpected URL: ${request.url}`);
		});

		const result = await extractFeishuStructuredContent(createDocument(
			'https://example.feishu.cn/wiki/wiki-token',
			'知识库节点'
		));

		expect(result?.title).toBe('项目库');
		expect(result?.content).toMatch(/<h2\b[^>]*>任务<\/h2>/);
		expect(result?.content).toContain('发布版本');
		expect(result?.content).toContain('小明');
	});

	test('keeps unsupported Wiki objects visible instead of dropping them', async () => {
		mocks.sendMessage.mockResolvedValue({
			success: true,
			data: { code: 0, data: { node: { obj_token: 'task-token', obj_type: 'task' } } },
		});

		const result = await extractFeishuStructuredContent(createDocument(
			'https://example.feishu.cn/wiki/wiki-token',
			'项目任务'
		));

		expect(result?.content).toContain('此飞书对象（task）暂时无法完整转换');
		expect(result?.content).toContain('需要用户身份授权');
		expect(result?.content).toContain('在飞书中打开原始内容');
	});

	test('returns an explicit permission fallback when Sheets API is denied', async () => {
		mocks.sendMessage.mockResolvedValue({
			success: false,
			error: 'Feishu API error 1310213: Permission Fail',
		});

		const result = await extractFeishuStructuredContent(createDocument(
			'https://example.feishu.cn/sheets/sht-token',
			'受限表格'
		));

		expect(result?.content).toContain('应用缺少读取权限');
		expect(result?.content).toContain('在飞书中打开原始内容');
	});

	test('expands an embedded Sheet token and preserves task and unknown blocks', async () => {
		mocks.sendMessage.mockImplementation(async (request: { url?: string }) => {
			if (request.url?.includes('/docx/v1/documents/doc-token/blocks?')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							items: [
								{ block_id: 'page', block_type: 1, children: ['sheet', 'task', 'unknown'] },
								{ block_id: 'sheet', block_type: 30, sheet: { token: 'sht-token_sheet1' } },
								{ block_id: 'task', block_type: 35, task: { task_id: 'task-id' } },
								{ block_id: 'unknown', block_type: 999, undefined_block: {} },
							],
						},
					},
				};
			}
			if (request.url?.endsWith('/docx/v1/documents/doc-token')) {
				return {
					success: true,
					data: { code: 0, data: { document: { title: '复杂文档' } } },
				};
			}
			if (request.url?.includes('/spreadsheets/sht-token/sheets/query')) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							sheets: [{
								sheet_id: 'sheet1',
								title: '嵌入表',
								grid_properties: { row_count: 2, column_count: 2 },
							}],
						},
					},
				};
			}
			if (request.url?.includes('/spreadsheets/sht-token/values/')) {
				return {
					success: true,
					data: { code: 0, data: { valueRange: { values: [['名称', '状态'], ['测试', '完成']] } } },
				};
			}
			throw new Error(`Unexpected URL: ${request.url}`);
		});

		const result = await extractFeishuStructuredContent(createHtmlDocument(
			'https://example.feishu.cn/docx/doc-token',
			'页面标题'
		));

		expect(result?.content).toContain('嵌入表');
		expect(result?.content).toContain('测试');
		expect(result?.content).toContain('飞书任务卡片');
		expect(result?.content).toContain('task:task:read');
		expect(result?.content).toContain('块类型 999');
	});
});
