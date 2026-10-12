import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";

export default defineConfig({
  root: resolve(__dirname, "src"),
  plugins: [react(), { name: "copy-extension-manifest", closeBundle() { mkdirSync(resolve(__dirname, "dist"), { recursive: true }); copyFileSync(resolve(__dirname, "public/manifest.json"), resolve(__dirname, "dist/manifest.json")); } }],
  publicDir: false,
  build: { outDir: resolve(__dirname, "dist"), emptyOutDir: true, rollupOptions: { input: { "sidepanel/index": resolve(__dirname, "src/sidepanel/index.html"), background: resolve(__dirname, "src/background.ts"), content: resolve(__dirname, "src/content.ts") }, output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" } } }
});
