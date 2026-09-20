// ============================================================
// Test setup — runs before each server test file via vitest setupFiles
// Must work when vitest is invoked from root workspace OR server workspace
// ============================================================

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Detect which workspace is running: root (pnpm test) or server (pnpm -r run test)
const serverDir = dirname(fileURLToPath(import.meta.url));
const rootWorkspaceDir = resolve(serverDir, '../../../');
const serverWorkspaceDir = resolve(serverDir, '../');
const isRootWorkspace = serverDir.includes('/apps/server/src');
const baseDir = isRootWorkspace ? rootWorkspaceDir : serverWorkspaceDir;

// Ensure DATABASE_URL is set (read from .env if not provided)
if (!process.env.DATABASE_URL) {
  try {
    const envPath = resolve(baseDir, '.env');
    const envContent = require('fs').readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const m = line.match(/^DATABASE_URL=(.+)/);
      if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
    }
  } catch { /* .env may not exist */ }
}
if (!process.env.DATABASE_URL) {
  throw new Error('[test-setup] DATABASE_URL not set');
}

// Ensure SESSION_SECRET is set
if (!process.env.SESSION_SECRET) {
  try {
    const envPath = resolve(baseDir, '.env');
    const envContent = require('fs').readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const m = line.match(/^SESSION_SECRET=(.+)/);
      if (m) { process.env.SESSION_SECRET = m[1].trim(); break; }
    }
  } catch { /* .env may not exist */ }
}
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'ci-test-secret-at-least-32-chars-long';
}

process.env.NODE_ENV = 'test';

// Seed the test DB so integration tests have admin user + geo game def
try {
  execSync(
    '../../node_modules/.bin/tsx ../../prisma/seed.ts',
    { cwd: __dirname, stdio: 'pipe', env: { ...process.env } }
  );
} catch {
  // Seed is idempotent (upserts), ignore errors
}
