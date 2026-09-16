// ============================================================
// Simple Server Runner (ESM) - v0.2.1
// ============================================================

import { start } from './server.js';

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
