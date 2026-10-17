import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Hub serves the built UI (FR-125). In development, Vite proxies the API to a local Hub.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.NOVA_HUB_URL ?? 'http://127.0.0.1:7419',
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
