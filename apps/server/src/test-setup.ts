// ============================================================
// Test setup — runs before each test file in the server workspace
// DATABASE_URL is set by the test script in package.json before vitest forks
// ============================================================

import { execSync } from 'child_process';

// Verify DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  throw new Error('[test-setup] DATABASE_URL not set — check package.json test script');
}

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-32chars-minimum-xxxxxxyyyyyy';

// Seed the test DB so integration tests have admin user + geo game def
try {
  execSync(
    '../../node_modules/.bin/tsx ../../prisma/seed.ts',
    { cwd: __dirname, stdio: 'pipe' }
  );
} catch {
  // Seed is idempotent (upserts), ignore errors
}
