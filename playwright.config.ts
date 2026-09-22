import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  timeout: 30000,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },

  // Two parallel web servers: Vite dev (5173) + Node.js API (3001)
  // Tests use baseURL: http://localhost:5173 (Vite proxies /api/* to 3001)
  webServer: [
    {
      command: 'pnpm --filter @quiz/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60000,
      env: {
        VITE_API_URL: 'http://localhost:3001',
        VITE_APP_URL: 'http://localhost:5173',
      },
    },
    {
      command: 'NODE_ENV=development node apps/server/dist/server.js',
      url: 'http://localhost:3001/api/v1/health',
      reuseExistingServer: true,
      timeout: 60000,
      env: {
        SESSION_SECRET: 'test-secret-32chars-long-for-e2e',
        DATABASE_URL: 'file:prisma/dev.db',
        ALLOWED_ORIGINS: 'http://localhost:3001,http://localhost:5173',
        PUBLIC_APP_URL: 'http://localhost:3001',
        NODE_ENV: 'development',
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
