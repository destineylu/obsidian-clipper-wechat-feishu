import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const srcDir = path.join(root, 'src');
const platformDir = path.join(srcDir, 'platforms');
const directExtractorPattern = /from\s+['"][^'"]*(feishu-extractor|bilibili-extractor)['"]/g;
const requiredHooks = [
	{
		file: path.join(srcDir, 'content.ts'),
		importPath: './platforms',
	},
	{
		file: path.join(srcDir, 'utils', 'content-extractor.ts'),
		importPath: '../platforms',
	},
	{
		file: path.join(srcDir, 'utils', 'reader.ts'),
		importPath: '../platforms',
	},
	{
		file: path.join(srcDir, 'background.ts'),
		importPath: './platforms',
	},
];

function walk(dir) {
	return readdirSync(dir).flatMap((entry) => {
		const fullPath = path.join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) return walk(fullPath);
		return fullPath.endsWith('.ts') ? [fullPath] : [];
	});
}

const failures = [];

for (const file of walk(srcDir)) {
	if (file.startsWith(platformDir)) continue;

	const source = readFileSync(file, 'utf8');
	for (const match of source.matchAll(directExtractorPattern)) {
		failures.push(`${path.relative(root, file)} imports ${match[1]} directly; import through src/platforms/* instead.`);
	}
}

for (const hook of requiredHooks) {
	const source = readFileSync(hook.file, 'utf8');
	if (!source.includes(hook.importPath)) {
		failures.push(`${path.relative(root, hook.file)} is missing platform hook ${hook.importPath}.`);
	}
}

if (failures.length) {
	console.error('Custom platform boundary check failed:');
	failures.forEach((failure) => console.error(`- ${failure}`));
	process.exit(1);
}

console.log('Custom platform boundary check passed.');
