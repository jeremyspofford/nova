import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The onnxruntime-web loader does a runtime `import()` of its .mjs glue; the
// Vite DEV server otherwise tries to transform that emscripten module and
// 500s ("no available backend"). Serve the self-hosted /vad/ .mjs raw.
// Production (nginx :8080) already serves it statically, so this is dev-only.
function serveVadAssetsRaw(): Plugin {
  const publicDir = path.dirname(fileURLToPath(import.meta.url))
  return {
    name: 'serve-vad-mjs-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url && url.startsWith('/vad/') && url.endsWith('.mjs')) {
          res.setHeader('Content-Type', 'text/javascript')
          createReadStream(path.join(publicDir, 'public', url)).pipe(res)
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [
    serveVadAssetsRaw(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Nova',
        short_name: 'Nova',
        description: 'Your brain, with a chat window.',
        theme_color: '#0c0a09',
        background_color: '#0c0a09',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // cache the app shell only — chat is useless offline, don't pretend
        navigateFallbackDenylist: [/^\/api/, /^\/health/],
        runtimeCaching: [],
        // the self-hosted VAD assets (~15 MB wasm + model) load on demand and
        // browser-cache — never precache them into the service worker
        globIgnores: ['**/vad/**'],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // same-origin in dev too: the browser talks only to :5173
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://backend:8000',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.VITE_PROXY_TARGET || 'http://backend:8000',
        changeOrigin: true,
      },
    },
  },
})
