import { defineConfig } from 'vitest/config';

// Root vitest config — aggregates all workspace tests
export default defineConfig({
  test: {
    // Run all workspace tests from root
    include: [
      'apps/server/src/**/*.test.ts',
      'apps/web/src/**/*.test.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/coverage/**',
      '**/build/**',
    ],
    globals: true,
    // Run server integration tests in the SAME VM fork to avoid Prisma singleton
    // issues. Module-level prisma is opened at file import time, so all test files
    // share it. Tests that need fresh DB state use createTestApp() + patching.
    pool: 'vmForks',
    poolOptions: {
      vmForks: {
        isolate: false,
      },
    },
    // Rate-limiter subprocess can take up to 20s to start under load
    hookTimeout: 30_000,
    testTimeout: 60_000,
  },
});
