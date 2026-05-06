/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During `npm run dev`, Vite proxies API calls so the browser never sees
// cross-origin requests. In production Docker, nginx does the same job.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      // Orchestrator — agents, tasks, keys, usage
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // LLM Gateway — models list
      '/v1': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      // Memory Service — memory inspector
      '/mem': {
        target: 'http://localhost:8002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mem/, ''),
      },
      // Recovery Service
      '/recovery-api': {
        target: 'http://localhost:8888',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/recovery-api/, ''),
      },
      // Cortex — autonomous brain service
      '/cortex-api': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cortex-api/, ''),
      },
      // Voice Service — STT/TTS
      '/voice-api': {
        target: 'http://localhost:8130',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/voice-api/, ''),
      },
      // Chat Bridge — Telegram/Slack adapter management
      '/bridge-api': {
        target: 'http://localhost:8090',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/bridge-api/, ''),
      },
      // Screenpipe Bridge — screen capture ingestion
      '/screenpipe-api': {
        target: 'http://localhost:8140',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/screenpipe-api/, ''),
      },
      // Embedded Editors
      // VS Code: proxy health probe to localhost:8443 (iframe loads direct)
      '/editor-vscode': {
        target: 'http://localhost:8443',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/editor-vscode/, ''),
      },
      // Neovim: proxy through nginx (ttyd supports --base-path)
      '/editor-neovim': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
