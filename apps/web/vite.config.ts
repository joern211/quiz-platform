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
      '@quiz/ui/styles/tokens.css': resolve(__dirname, '../../packages/ui/src/styles/tokens.css'),
      '@quiz/shared': resolve(__dirname, '../../packages/shared/src'),
      '@quiz/game-sdk': resolve(__dirname, '../../packages/game-sdk/src'),
    },
  },
  
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5173',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:5173',
        ws: true,
      },
    },
  },
  
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
