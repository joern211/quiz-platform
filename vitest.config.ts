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
    // Each test file gets its own fork and DB to prevent cross-test-state pollution.
    // isolate: true ensures test-setup.ts runs once per file (seed, env vars).
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        isolate: true,
      },
    },
    // Rate-limiter subprocess can take up to 20s to start under load
    hookTimeout: 30_000,
    testTimeout: 60_000,
  },
});
