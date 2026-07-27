export interface FeishuSheetPreview {
	title: string;
	rows: unknown[][];
	totalRows?: number;
	totalColumns?: number;
	truncated?: boolean;
}

export interface FeishuBitableRecordPreview {
	fields: Record<string, unknown>;
}

export interface FeishuBitableTablePreview {
	title: string;
	fieldNames: string[];
	records: FeishuBitableRecordPreview[];
	totalRecords?: number;
	truncated?: boolean;
}

export interface FeishuRenderedResource {
	content: string;
	wordCount: number;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
	return escapeHtml(value);
}

function formatObjectValue(value: Record<string, unknown>): string {
	for (const key of ['text', 'name', 'title', 'display_name', 'url', 'link', 'file_name']) {
		const candidate = value[key];
		if (typeof candidate === 'string' && candidate.trim()) return candidate;
	}

	const id = value.id || value.record_id || value.open_id || value.user_id;
	if (typeof id === 'string' && id.trim()) return id;

	return Object.entries(value)
		.filter(([, nested]) => nested !== null && nested !== undefined && nested !== '')
		.map(([key, nested]) => `${key}: ${formatFeishuResourceValue(nested)}`)
		.filter(entry => !entry.endsWith(': '))
		.join('; ');
}

export function formatFeishuResourceValue(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		return value
			.map(formatFeishuResourceValue)
			.filter(Boolean)
			.join(', ');
	}
	if (typeof value === 'object') return formatObjectValue(value as Record<string, unknown>);
	return String(value);
}

function renderValue(value: unknown): string {
	const text = formatFeishuResourceValue(value);
	if (/^https?:\/\//i.test(text)) {
		return `<a href="${escapeAttr(text)}">${escapeHtml(text)}</a>`;
	}
	return escapeHtml(text);
}

function countWords(text: string): number {
	const normalized = text.trim();
	if (!normalized) return 0;
	return normalized.split(/\s+/).filter(Boolean).length || normalized.length;
}

function renderSourceLink(sourceUrl: string): string {
	return `<p><a href="${escapeAttr(sourceUrl)}">在飞书中打开原始内容</a></p>`;
}

export function renderFeishuSheetResource(
	title: string,
	sourceUrl: string,
	sheets: FeishuSheetPreview[],
	omittedSheetCount = 0
): FeishuRenderedResource {
	const parts: string[] = [
		`<h1>${escapeHtml(title || '飞书电子表格')}</h1>`,
		'<blockquote><p>以下为电子表格的只读预览；公式、样式、合并单元格和交互能力可能无法完整保留。</p></blockquote>',
	];
	const textParts: string[] = [title];

	for (const sheet of sheets) {
		parts.push(`<h2>${escapeHtml(sheet.title || '未命名工作表')}</h2>`);
		textParts.push(sheet.title);
		if (!sheet.rows.length) {
			parts.push('<p>该工作表没有可预览的数据。</p>');
			continue;
		}

		const width = Math.max(...sheet.rows.map(row => row.length), 0);
		const rows = sheet.rows.map((row, rowIndex) => {
			const tag = rowIndex === 0 ? 'th' : 'td';
			const cells = Array.from({ length: width }, (_, columnIndex) => {
				const value = row[columnIndex];
				textParts.push(formatFeishuResourceValue(value));
				return `<${tag}>${renderValue(value)}</${tag}>`;
			});
			return `<tr>${cells.join('')}</tr>`;
		});
		parts.push(`<table>${rows.join('')}</table>`);

		if (sheet.truncated) {
			const dimensions = sheet.totalRows && sheet.totalColumns
				? `（原表约 ${sheet.totalRows} 行 × ${sheet.totalColumns} 列）`
				: '';
			parts.push(`<blockquote><p>预览已截断${dimensions}，请在飞书中查看完整数据。</p></blockquote>`);
		}
	}

	if (omittedSheetCount > 0) {
		parts.push(`<blockquote><p>另有 ${omittedSheetCount} 个工作表未在剪藏预览中展开。</p></blockquote>`);
	}
	parts.push(renderSourceLink(sourceUrl));

	return {
		content: parts.join(''),
		wordCount: countWords(textParts.join(' ')),
	};
}

export function renderFeishuBitableResource(
	title: string,
	sourceUrl: string,
	tables: FeishuBitableTablePreview[],
	omittedTableCount = 0
): FeishuRenderedResource {
	const parts: string[] = [
		`<h1>${escapeHtml(title || '飞书多维表格')}</h1>`,
		'<blockquote><p>以下为多维表格的只读记录预览；视图筛选、公式、关联关系、自动化和权限规则仍以飞书原文为准。</p></blockquote>',
	];
	const textParts: string[] = [title];

	for (const table of tables) {
		parts.push(`<h2>${escapeHtml(table.title || '未命名数据表')}</h2>`);
		textParts.push(table.title);
		if (!table.records.length) {
			parts.push('<p>该数据表没有可预览的记录。</p>');
			continue;
		}

		const headers = table.fieldNames.map(name => {
			textParts.push(name);
			return `<th>${escapeHtml(name)}</th>`;
		});
		const rows = table.records.map(record => {
			const cells = table.fieldNames.map(name => {
				const value = record.fields[name];
				textParts.push(formatFeishuResourceValue(value));
				return `<td>${renderValue(value)}</td>`;
			});
			return `<tr>${cells.join('')}</tr>`;
		});
		parts.push(`<table><tr>${headers.join('')}</tr>${rows.join('')}</table>`);

		if (table.truncated) {
			const total = typeof table.totalRecords === 'number'
				? `（共 ${table.totalRecords} 条记录）`
				: '';
			parts.push(`<blockquote><p>记录预览已截断${total}，请在飞书中查看完整数据。</p></blockquote>`);
		}
	}

	if (omittedTableCount > 0) {
		parts.push(`<blockquote><p>另有 ${omittedTableCount} 个数据表未在剪藏预览中展开。</p></blockquote>`);
	}
	parts.push(renderSourceLink(sourceUrl));

	return {
		content: parts.join(''),
		wordCount: countWords(textParts.join(' ')),
	};
}

export function renderUnsupportedFeishuResource(
	resourceType: string,
	sourceUrl: string,
	title = '飞书复杂对象',
	reason?: string
): FeishuRenderedResource {
	const safeType = resourceType || 'unknown';
	const reasonText = reason ? `：${reason}` : '';
	const content = [
		`<h1>${escapeHtml(title)}</h1>`,
		`<blockquote><p>此飞书对象（${escapeHtml(safeType)}）暂时无法完整转换${escapeHtml(reasonText)}。对象没有被丢弃，请通过下方链接查看原始内容。</p></blockquote>`,
		renderSourceLink(sourceUrl),
	].join('');
	return {
		content,
		wordCount: countWords(`${title} ${safeType} ${reason || ''}`),
	};
}
