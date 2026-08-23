import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Tauri 官方推荐配置：热重载走 devUrl (http://localhost:5173)
// 生产构建输出到 ui/dist，由 Tauri frontendDist / 信令服务器静态托管
export default defineConfig({
  plugins: [react()],
  // 防止 Vite 清屏遮挡 Tauri 的编译输出
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 不监听 src-tauri（Rust 变更由 tauri dev 自己处理）
      ignored: [
        "**/src-tauri/**",
        // 编辑器原子保存的临时目录/文件（VS Code 等）：监听它们会被
        // 随即删除/锁定的文件触发 EBUSY，导致 dev server 崩溃
        "**/.*.tmpdir/**",
        "**/*.tmp",
      ],
    },
    host: "0.0.0.0",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
  },
})
