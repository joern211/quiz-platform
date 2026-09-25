// ============================================================
// Vite Configuration
// ============================================================

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@quiz/ui': resolve(__dirname, '../../packages/ui/src'),
      '@quiz/shared': resolve(__dirname, '../../packages/shared/src'),
      '@quiz/game-sdk': resolve(__dirname, '../../packages/game-sdk/src'),
    },
  },

  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // http-proxy events via configure-Proxy
        selfHandleResponse: false,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
