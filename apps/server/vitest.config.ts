import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Keep all test files in the SAME VM fork so the module-level prisma
    // singleton (opened at file-import time) is shared. Tests that need
    // fresh DB state use createTestApp() + patching.
    pool: 'vmForks',
    poolOptions: {
      vmForks: { isolate: false },
    },
    // Allow afterAll hooks (subprocess teardown) up to 30 seconds
    hookTimeout: 30_000,
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
