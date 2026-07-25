import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	define: {
		DEBUG_MODE: false,
	},
	test: {
		include: ['src/**/*.test.ts'],
		globals: true,
		alias: {
			'webextension-polyfill': fileURLToPath(new URL('./src/utils/__mocks__/webextension-polyfill.ts', import.meta.url)),
		},
	},
});
