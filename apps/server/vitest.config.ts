import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration files patch the lazy Prisma proxy before app startup.
    pool: 'vmForks',
    // These integration files intentionally share the seeded SQLite database.
    // Run files sequentially; races inside each multiplayer test remain real.
    fileParallelism: false,
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
