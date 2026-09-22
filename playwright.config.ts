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

  // Vite (5173) + Node.js production server (3001)
  // Vite proxies /api/* und /socket.io/* an Port 3001
  // DATABASE_URL from process.env or default for local dev
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
      // Use the BUILT server so rate-limiter integration tests can import it
      // Dist already built by CI "Build all apps" step before this runs
      command:
        'DATABASE_URL="${DATABASE_URL:-file:prisma/dev.db}" ' +
        'SESSION_SECRET="${SESSION_SECRET:-test-secret-32chars-long-for-e2e}" ' +
        'NODE_ENV=development ' +
        'node apps/server/dist/server.js',
      url: 'http://localhost:3001/api/v1/health',
      reuseExistingServer: true,
      timeout: 60000,
      env: {
        DATABASE_URL: 'file:prisma/dev.db',
        SESSION_SECRET: 'test-secret-32chars-long-for-e2e',
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
