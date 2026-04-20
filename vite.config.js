import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Apex renderer. Output goes to ./dist which Electron loads in prod.
export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
