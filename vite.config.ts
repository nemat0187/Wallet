import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  server: {
    port: 5173,
    // During local development the API runs in `wrangler dev` on :8787.
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});
