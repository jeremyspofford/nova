import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
      "/ws":  { target: "ws://localhost:8004",  ws: true, changeOrigin: true },
      "/voice-api": { target: "http://localhost:8003", changeOrigin: true, rewrite: (p) => p.replace(/^\/voice-api/, "") },
    },
  },
});
