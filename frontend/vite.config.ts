import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In local development the browser talks to Vite, which proxies API paths to
// the FastAPI backend, so the session cookie is same-origin.
const backend = process.env.ALPHA_BACKEND_URL ?? "http://127.0.0.1:8000";
const proxied = ["/api", "/auth", "/engine", "/kill", "/health"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend, changeOrigin: false }])),
  },
  build: { outDir: "dist", sourcemap: false },
});
