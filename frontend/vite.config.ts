import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
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
