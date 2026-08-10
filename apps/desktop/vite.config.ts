import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const corePort = process.env.HOPLANE_CORE_PORT ?? "21722";

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: `http://127.0.0.1:${corePort}`,
        changeOrigin: true,
        ws: true,
        // Core 通过 Origin 判定同源 UI 请求；开发模式下统一重写为 Core 地址。
        headers: { origin: `http://127.0.0.1:${corePort}` }
      }
    }
  }
});
