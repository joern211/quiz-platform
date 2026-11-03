// TEST-ONLY harness config (port 5207). Same aliases as apps/web/vite.config.ts; /api goes to the harness backend (server.ts, port 5206).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5207, host: '127.0.0.1', fs: { allow: [resolve(__dirname, '../../../..')] }, proxy: { '/api': 'http://127.0.0.1:5206' } },
  resolve: { alias: {
    '@': resolve(__dirname, '../../src'),
    '@quiz/ui': resolve(__dirname, '../../../../packages/ui/src'),
    '@quiz/shared': resolve(__dirname, '../../../../packages/shared/src'),
  } },
});
