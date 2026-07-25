import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const forbiddenTrackedPrefixes = ['.playwright-mcp/'];
const sensitivePatterns = [
	{
		name: 'complete Feishu/Lark document URL',
		pattern: /https?:\/\/[a-z0-9.-]+\.(?:feishu\.cn|larksuite\.com)\/(?:docx|wiki|docs?)\/[a-z0-9_-]{8,}/gi,
	},
	{
		name: 'literal Feishu/Lark App Secret',
		pattern: /(?:feishu|lark)?[_-]?app[_-]?secret\s*[:=]\s*['"][^'"<\s]{8,}['"]/gi,
	},
];

function trackedFiles() {
	const output = execFileSync('git', ['ls-files', '-z'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return output.split('\0').filter(Boolean);
}

function lineNumberAt(source, index) {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor++) {
		if (source.charCodeAt(cursor) === 10) line++;
	}
	return line;
}

const failures = [];
const files = trackedFiles();

for (const file of files) {
	const normalized = file.replaceAll('\\', '/');
	if (forbiddenTrackedPrefixes.some(prefix => normalized.startsWith(prefix))) {
		failures.push(`${file}: tracked browser-control artifact`);
		continue;
	}

	let stat;
	try {
		stat = statSync(file);
	} catch {
		continue;
	}
	if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES) continue;

	const buffer = readFileSync(file);
	if (buffer.includes(0)) continue;
	const source = buffer.toString('utf8');

	for (const { name, pattern } of sensitivePatterns) {
		pattern.lastIndex = 0;
		for (const match of source.matchAll(pattern)) {
			failures.push(`${file}:${lineNumberAt(source, match.index || 0)}: ${name}`);
		}
	}
}

if (failures.length) {
	console.error('Sensitive artifact check failed:');
	failures.forEach(failure => console.error(`- ${failure}`));
	process.exit(1);
}

console.log('Sensitive artifact check passed.');
