import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
	},
	resolve: {
		alias: {
			// The `obsidian` npm package ships types only; it cannot be imported
			// in the Node test environment. Modules loaded by the tests that
			// reference it at import time get these minimal class stubs instead.
			obsidian: fileURLToPath(new URL('./tests/mocks/obsidian.ts', import.meta.url)),
		},
	},
});
