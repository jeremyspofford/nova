import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Stamp the real client IP on every proxied request, exactly as nginx does
// for :8080. Without it the backend saw no X-Real-IP and treated the caller
// as this machine — and since vite listens on 0.0.0.0, "the caller" included
// every container on the compose network. searxng, media and mcp-runner all
// handle untrusted input and could reach http://frontend:5173/api/v1/... to
// get tokenless admin, including the admin token itself. The host's own
// browser still arrives via docker's gateway IP, which the backend does
// recognise as local, so nothing changes for normal use.
function forwardRealIp(proxy: { on: (e: string, cb: (...a: never[]) => void) => void }) {
  proxy.on('proxyReq', ((proxyReq: { setHeader: (k: string, v: string) => void },
                        req: { socket?: { remoteAddress?: string } }) => {
    const ip = req.socket?.remoteAddress ?? ''
    proxyReq.setHeader('X-Real-IP', ip.replace(/^::ffff:/, ''))
  }) as never)
}

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
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // cache the app shell only — chat is useless offline, don't pretend
        navigateFallbackDenylist: [/^\/api/, /^\/health/],
        runtimeCaching: [],
        // wasm runtimes + onnx models (VAD, wake) load on demand and
        // browser-cache — never precache them into the service worker
        globIgnores: ['**/vad/**', '**/wake/**', '**/*.wasm'],
        // web push lives in a small static file so the SW stays generated
        // (no injectManifest migration); push-sw.js is precached by glob
        importScripts: ['push-sw.js'],
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
        configure: forwardRealIp,
      },
      '/health': {
        target: process.env.VITE_PROXY_TARGET || 'http://backend:8000',
        changeOrigin: true,
        configure: forwardRealIp,
      },
    },
  },
})
