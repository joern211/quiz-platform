import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  timeout: 30000,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },

  webServer: {
    command:
      'pnpm --filter @quiz/server dev',
    url: 'http://localhost:3001/api/v1/health',
    reuseExistingServer: true,
    timeout: 60000,
    env: {
      SESSION_SECRET: 'test-secret-32chars-long-for-e2e',
      DATABASE_URL: 'file:prisma/dev.db',
      ALLOWED_ORIGINS: 'http://localhost:3001',
      PUBLIC_APP_URL: 'http://localhost:3001',
      WEB_DIST_PATH: 'apps/web/dist',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
