import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    minify: "esbuild",
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Cargo build trees can contain tens of thousands of files. Watching them caused the
      // Vite process to retain more than 71,000 Windows file handles during development.
      ignored: [
        "**/src-tauri/target",
        "**/src-tauri/target/**",
        "**/src-tauri/target-*",
        "**/src-tauri/target-*/**",
      ],
    },
    hmr: {
      port: 1421
    }
  },
  clearScreen: false
});
