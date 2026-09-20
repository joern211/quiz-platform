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
    // Server integration tests need their own DB. Run server tests in separate
    // pool from web tests to avoid DB contention.
    // Integration tests run with NODE_ENV=test for conditional rate limiter.
    pool: 'forks',
    poolOptions: {
      forks: {
        // false = each test file gets its own subprocess with own DB
        singleFork: false,
      },
    },
  },
});
