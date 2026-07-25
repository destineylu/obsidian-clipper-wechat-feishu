import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const srcDir = path.join(root, 'src');
const platformDir = path.join(srcDir, 'platforms');
const directExtractorPattern = /from\s+['"][^'"]*((?:feishu|bilibili|douyin|xiaohongshu|wechat)-extractor)['"]/g;
const expectedPlatforms = [
	['wechat', 'wechatPlatform'],
	['github', 'githubPlatform'],
	['feishu', 'feishuPlatform'],
	['bilibili', 'bilibiliPlatform'],
	['douyin', 'douyinPlatform'],
	['xiaohongshu', 'xiaohongshuPlatform'],
	['x', 'xPlatform'],
];
const requiredHooks = [
	{
		file: path.join(srcDir, 'content.ts'),
		importPath: './platforms',
		registryCalls: true,
		calls: ['beforeDomNormalize', 'afterExtract', 'extractStructuredContent'],
	},
	{
		file: path.join(srcDir, 'utils', 'content-extractor.ts'),
		importPath: '../platforms',
		registryCalls: true,
		calls: ['afterMarkdown'],
	},
	{
		file: path.join(srcDir, 'utils', 'reader.ts'),
		importPath: '../platforms',
		registryCalls: true,
		calls: ['extractReaderContent', 'captureReaderState', 'enhanceReader', 'onReaderRestore'],
	},
	{
		file: path.join(srcDir, 'background.ts'),
		importPath: './platforms',
		registryCalls: false,
		calls: ['registerPlatformBackgroundHandlers', 'handlePlatformBackgroundMessage'],
	},
	{
		file: path.join(srcDir, 'utils', 'clip-utils.ts'),
		importPath: '../platforms',
		registryCalls: true,
		calls: ['beforeDomNormalize', 'afterExtract'],
	},
	{
		file: path.join(srcDir, 'core', 'reader-view.ts'),
		importPath: '../platforms',
		registryCalls: true,
		calls: ['beforeDomNormalize', 'afterExtract', 'extractReaderContent', 'extractStructuredContent'],
	},
	{
		file: path.join(srcDir, 'core', 'popup.ts'),
		importPath: '../platforms',
		registryCalls: true,
		calls: ['saveToObsidian'],
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
const platformIndex = readFileSync(path.join(platformDir, 'index.ts'), 'utf8');

for (const [id, variable] of expectedPlatforms) {
	if (!platformIndex.includes(`from './${id}'`)) {
		failures.push(`src/platforms/index.ts is missing the ${id} platform import.`);
	}
	const registrationPattern = new RegExp(`\\b${variable}\\s*,`);
	if (!registrationPattern.test(platformIndex)) {
		failures.push(`src/platforms/index.ts is missing ${variable} from the registry.`);
	}
}

for (const file of walk(srcDir)) {
	if (file.startsWith(platformDir)) continue;
	if (file.endsWith('.test.ts')) continue;

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
	for (const call of hook.calls) {
		const callPattern = hook.registryCalls
			? new RegExp(`\\bplatformRegistry\\s*\\.\\s*${call}\\s*\\(`)
			: new RegExp(`\\b${call}\\s*\\(`);
		if (!callPattern.test(source)) {
			failures.push(`${path.relative(root, hook.file)} is missing platform call ${call}.`);
		}
	}
}

if (failures.length) {
	console.error('Custom platform boundary check failed:');
	failures.forEach((failure) => console.error(`- ${failure}`));
	process.exit(1);
}

console.log('Custom platform boundary check passed.');
