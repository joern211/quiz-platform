// TEST-ONLY harness config (port 5197). Same aliases as apps/web/vite.config.ts; /api goes to the harness backend (server.ts, port 5196).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5197, host: '127.0.0.1', fs: { allow: [resolve(__dirname, '../../../..')] }, proxy: { '/api': 'http://127.0.0.1:5196' } },
  resolve: { alias: {
    '@': resolve(__dirname, '../../src'),
    '@quiz/ui': resolve(__dirname, '../../../../packages/ui/src'),
    '@quiz/shared': resolve(__dirname, '../../../../packages/shared/src'),
  } },
});
