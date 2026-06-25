import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// 前端（webview）建置設定。Node sidecar（src/server.ts、src/services/*）
// 不在此 bundle——前端只透過 src/lib/api.ts 以 HTTP 呼叫 sidecar。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 把 package.json 版本號注入前端（單一來源，顯示在標題旁）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/data/**"] },
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
});
