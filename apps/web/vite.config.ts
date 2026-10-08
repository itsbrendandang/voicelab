import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER = "http://localhost:8787";

const proxy = {
  "/ws": { target: SERVER, ws: true, changeOrigin: true },
  "/api": { target: SERVER, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { sourcemap: true },
});
