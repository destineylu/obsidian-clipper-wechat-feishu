import {
	type FeishuBitableRecordPreview,
	type FeishuBitableTablePreview,
	type FeishuSheetPreview,
} from './feishu-resource-renderer';

const SHEET_PREVIEW_MAX_SHEETS = 5;
const SHEET_PREVIEW_MAX_ROWS = 100;
const SHEET_PREVIEW_MAX_COLUMNS = 26;
const BITABLE_PREVIEW_MAX_TABLES = 5;
const BITABLE_PREVIEW_MAX_FIELDS = 20;
const BITABLE_PREVIEW_MAX_RECORDS = 100;

export type FeishuApiFetch = (url: string) => Promise<any>;

export interface FeishuSheetResourcePreview {
	title: string;
	sheets: FeishuSheetPreview[];
	omittedSheetCount: number;
}

export interface FeishuBitableResourcePreview {
	title: string;
	tables: FeishuBitableTablePreview[];
	omittedTableCount: number;
}

function getOpenApiHost(documentUrl: string): string {
	return documentUrl.includes('.larksuite.com/')
		|| documentUrl.includes('.larksuite.com?')
		|| documentUrl.includes('.larksuite.com#')
		? 'https://open.larksuite.com'
		: 'https://open.feishu.cn';
}

function numberToSheetColumn(value: number): string {
	let column = '';
	let current = Math.max(1, Math.floor(value));
	while (current > 0) {
		current -= 1;
		column = String.fromCharCode(65 + (current % 26)) + column;
		current = Math.floor(current / 26);
	}
	return column;
}

function getSelectedResourceId(documentUrl: string, key: 'sheet' | 'table'): string | null {
	try {
		return new URL(documentUrl).searchParams.get(key);
	} catch {
		return null;
	}
}

export function getFeishuResourceErrorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/permission|forbidden|1310213|1254302/i.test(message)) {
		return '应用缺少读取权限，或该资源尚未授权给应用';
	}
	return '飞书接口暂时无法读取该对象';
}

export async function fetchSheetResourcePreview(
	fetchApi: FeishuApiFetch,
	spreadsheetToken: string,
	documentUrl: string,
	fallbackTitle = '',
	requestedSheetId?: string | null
): Promise<FeishuSheetResourcePreview> {
	const openApiHost = getOpenApiHost(documentUrl);
	const sheetResult = await fetchApi(
		`${openApiHost}/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`
	);
	const allSheets = Array.isArray(sheetResult?.data?.sheets)
		? sheetResult.data.sheets as Array<{
			sheet_id?: string;
			title?: string;
			hidden?: boolean;
			grid_properties?: { row_count?: number; column_count?: number };
		}>
		: [];
	const selectedSheetId = requestedSheetId || getSelectedResourceId(documentUrl, 'sheet');
	const selectedSheets = selectedSheetId
		? allSheets.filter(sheet => sheet.sheet_id === selectedSheetId)
		: allSheets.filter(sheet => !sheet.hidden);
	const sheetsToPreview = selectedSheets.slice(0, SHEET_PREVIEW_MAX_SHEETS);
	const sheets: FeishuSheetPreview[] = [];

	for (const sheet of sheetsToPreview) {
		if (!sheet.sheet_id) continue;
		const totalRows = sheet.grid_properties?.row_count || SHEET_PREVIEW_MAX_ROWS;
		const totalColumns = sheet.grid_properties?.column_count || SHEET_PREVIEW_MAX_COLUMNS;
		const previewRows = Math.min(totalRows, SHEET_PREVIEW_MAX_ROWS);
		const previewColumns = Math.min(totalColumns, SHEET_PREVIEW_MAX_COLUMNS);
		const range = `${sheet.sheet_id}!A1:${numberToSheetColumn(previewColumns)}${previewRows}`;
		const valuesResult = await fetchApi(
			`${openApiHost}/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`
		);
		const rows = Array.isArray(valuesResult?.data?.valueRange?.values)
			? valuesResult.data.valueRange.values as unknown[][]
			: [];
		sheets.push({
			title: sheet.title || sheet.sheet_id,
			rows,
			totalRows,
			totalColumns,
			truncated: totalRows > previewRows || totalColumns > previewColumns,
		});
	}

	return {
		title: fallbackTitle || '飞书电子表格',
		sheets,
		omittedSheetCount: Math.max(0, selectedSheets.length - sheetsToPreview.length),
	};
}

function getBitableFieldNames(
	fieldItems: Array<{ field_name?: string }>,
	records: Array<{ fields?: Record<string, unknown> }>
): string[] {
	const ordered = fieldItems
		.map(field => field.field_name?.trim())
		.filter((name): name is string => !!name);
	for (const record of records) {
		for (const name of Object.keys(record.fields || {})) {
			if (!ordered.includes(name)) ordered.push(name);
		}
	}
	return ordered.slice(0, BITABLE_PREVIEW_MAX_FIELDS);
}

export async function fetchBitableResourcePreview(
	fetchApi: FeishuApiFetch,
	appToken: string,
	documentUrl: string,
	fallbackTitle = '',
	requestedTableId?: string | null
): Promise<FeishuBitableResourcePreview> {
	const openApiHost = getOpenApiHost(documentUrl);
	const encodedAppToken = encodeURIComponent(appToken);
	const [appResult, tablesResult] = await Promise.all([
		fetchApi(`${openApiHost}/open-apis/bitable/v1/apps/${encodedAppToken}`),
		fetchApi(`${openApiHost}/open-apis/bitable/v1/apps/${encodedAppToken}/tables?page_size=100`),
	]);
	const allTables = Array.isArray(tablesResult?.data?.items)
		? tablesResult.data.items as Array<{ table_id?: string; name?: string }>
		: [];
	const selectedTableId = requestedTableId || getSelectedResourceId(documentUrl, 'table');
	const selectedTables = selectedTableId
		? allTables.filter(table => table.table_id === selectedTableId)
		: allTables;
	const tablesToPreview = selectedTables.slice(0, BITABLE_PREVIEW_MAX_TABLES);
	const tables: FeishuBitableTablePreview[] = [];

	for (const table of tablesToPreview) {
		if (!table.table_id) continue;
		const encodedTableId = encodeURIComponent(table.table_id);
		const [fieldsResult, recordsResult] = await Promise.all([
			fetchApi(
				`${openApiHost}/open-apis/bitable/v1/apps/${encodedAppToken}/tables/${encodedTableId}/fields?page_size=100`
			),
			fetchApi(
				`${openApiHost}/open-apis/bitable/v1/apps/${encodedAppToken}/tables/${encodedTableId}/records?page_size=${BITABLE_PREVIEW_MAX_RECORDS}&text_field_as_array=true&automatic_fields=true`
			),
		]);
		const fieldItems = Array.isArray(fieldsResult?.data?.items)
			? fieldsResult.data.items as Array<{ field_name?: string }>
			: [];
		const records = Array.isArray(recordsResult?.data?.items)
			? recordsResult.data.items as Array<{ fields?: Record<string, unknown> }>
			: [];
		const recordPreviews: FeishuBitableRecordPreview[] = records
			.map(record => ({ fields: record.fields || {} }));
		tables.push({
			title: table.name || table.table_id,
			fieldNames: getBitableFieldNames(fieldItems, records),
			records: recordPreviews,
			totalRecords: typeof recordsResult?.data?.total === 'number'
				? recordsResult.data.total
				: undefined,
			truncated: recordsResult?.data?.has_more === true
				|| (typeof recordsResult?.data?.total === 'number'
					&& recordsResult.data.total > records.length),
		});
	}

	return {
		title: appResult?.data?.app?.name || fallbackTitle || '飞书多维表格',
		tables,
		omittedTableCount: Math.max(0, selectedTables.length - tablesToPreview.length),
	};
}

export function parseEmbeddedBitableToken(token: string): { appToken: string; tableId?: string } {
	const match = token.match(/^(.+?)_(tbl[\w-]+)$/);
	return match
		? { appToken: match[1], tableId: match[2] }
		: { appToken: token };
}

export function parseEmbeddedSheetToken(token: string): { spreadsheetToken: string; sheetId?: string } {
	const match = token.match(/^(.+?)_([^_]+)$/);
	return match
		? { spreadsheetToken: match[1], sheetId: match[2] }
		: { spreadsheetToken: token };
}

export function withoutTopLevelResourceHeading(content: string): string {
	return content.replace(/^<h1>[\s\S]*?<\/h1>/, '');
}
