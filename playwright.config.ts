import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },

  // Start both backend (3001) and Vite (5173) before running E2E tests
  // Server must be started BEFORE Vite since Vite proxies to :3001
  webServer: [
    {
      command: 'cd /Users/joern.r/quiz-platform && pnpm --filter @quiz/server start',
      port: 3001,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL ?? 'file:../prisma/dev.db',
        SESSION_SECRET: 'test-secret-32chars-long-for-e2e',
        ALLOWED_ORIGINS: 'http://localhost:3001,http://localhost:5173',
        PUBLIC_APP_URL: 'http://localhost:3001',
        NODE_ENV: 'development',
      },
    },
    {
      command: 'cd /Users/joern.r/quiz-platform && pnpm --filter @quiz/web -- --host',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        VITE_API_URL: 'http://localhost:3001',
        VITE_APP_URL: 'http://localhost:5173',
      },
    },
  ],

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
