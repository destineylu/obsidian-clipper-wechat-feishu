import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(scriptDirectory, '..');
const pluginDirectory = resolve(rootDirectory, 'companion-plugin');
const outputDirectory = resolve(pluginDirectory, 'dist');

await mkdir(outputDirectory, { recursive: true });
await build({
	entryPoints: [resolve(pluginDirectory, 'src/main.ts')],
	outfile: resolve(outputDirectory, 'main.js'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	external: [
		'obsidian',
		'electron',
		'@codemirror/state',
		'@codemirror/view',
	],
	sourcemap: true,
	logLevel: 'info',
});

await Promise.all([
	cp(
		resolve(pluginDirectory, 'manifest.json'),
		resolve(outputDirectory, 'manifest.json')
	),
	cp(
		resolve(pluginDirectory, 'styles.css'),
		resolve(outputDirectory, 'styles.css')
	),
]);
