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
    // Server tests use node env, web uses jsdom
    // Run in separate passes via the workspace scripts instead
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
