// TEST-ONLY harness config (port 5198). Same aliases as apps/web/vite.config.ts; no proxy, no app routes.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5198, host: '127.0.0.1', fs: { allow: [resolve(__dirname, '../../../..')] } },
  resolve: { alias: {
    '@': resolve(__dirname, '../../src'),
    '@quiz/ui': resolve(__dirname, '../../../../packages/ui/src'),
    '@quiz/shared': resolve(__dirname, '../../../../packages/shared/src'),
  } },
});
