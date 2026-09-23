import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  timeout: 30000,
  reporter: [['list']],
  outputDir: process.env.PLAYWRIGHT_REPORT_DIR ? `${process.env.PLAYWRIGHT_REPORT_DIR}/` : 'playwright-report/',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },

  // Frontend (Vite, port 5173)
  // Vite proxies /api/* and /socket.io/* to the Node.js server (port 3001)
  // The Node.js server must already be running — start it in CI before Playwright.
  webServer: {
    command: 'pnpm --filter @quiz/web dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60000,
    env: {
      VITE_API_URL: 'http://localhost:3001',
      VITE_APP_URL: 'http://localhost:5173',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
