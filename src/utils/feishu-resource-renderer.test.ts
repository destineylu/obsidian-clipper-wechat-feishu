import { describe, expect, test } from 'vitest';

import {
	formatFeishuResourceValue,
	renderFeishuBitableResource,
	renderFeishuSheetResource,
	renderUnsupportedFeishuResource,
} from './feishu-resource-renderer';

describe('Feishu complex resource renderer', () => {
	test('renders a bounded sheet preview with a truncation warning', () => {
		const result = renderFeishuSheetResource('预算表', 'https://example.feishu.cn/sheets/token', [{
			title: '汇总',
			rows: [['项目', '金额'], ['服务器', 1200]],
			totalRows: 500,
			totalColumns: 20,
			truncated: true,
		}]);

		expect(result.content).toContain('<h2>汇总</h2>');
		expect(result.content).toContain('<th>项目</th>');
		expect(result.content).toContain('<td>1200</td>');
		expect(result.content).toContain('预览已截断');
		expect(result.content).toContain('在飞书中打开原始内容');
	});

	test('renders Bitable object fields without object string leakage', () => {
		const result = renderFeishuBitableResource('项目库', 'https://example.feishu.cn/base/token', [{
			title: '任务',
			fieldNames: ['名称', '负责人', '标签'],
			records: [{
				fields: {
					名称: [{ text: '发布版本' }],
					负责人: [{ name: '小明' }],
					标签: ['紧急', '公开'],
				},
			}],
		}]);

		expect(result.content).toContain('发布版本');
		expect(result.content).toContain('小明');
		expect(result.content).toContain('紧急, 公开');
		expect(result.content).not.toContain('[object Object]');
	});

	test('keeps unsupported resources visible and linked', () => {
		const result = renderUnsupportedFeishuResource(
			'task',
			'https://example.feishu.cn/wiki/token',
			'任务卡片',
			'需要用户授权'
		);

		expect(result.content).toContain('task');
		expect(result.content).toContain('需要用户授权');
		expect(result.content).toContain('https://example.feishu.cn/wiki/token');
	});

	test('formats links and structured values predictably', () => {
		expect(formatFeishuResourceValue([{ text: '说明' }, { url: 'https://example.com' }]))
			.toBe('说明, https://example.com');
	});
});
