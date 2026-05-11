import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Bundle is served by the keybroker at /ui/ — `base` keeps asset URLs
// relative so the same dist works whether you `vite preview` it or let
// the broker serve it via @fastify/static.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // During `vite dev`, proxy API calls to the running broker so the
    // dev server feels like the production /ui mount. Run the broker
    // separately with `npm run serve` from the repo root.
    proxy: {
      "/health": "http://127.0.0.1:7843",
      "/metrics": "http://127.0.0.1:7843",
      "/forecast": "http://127.0.0.1:7843",
    },
  },
});
