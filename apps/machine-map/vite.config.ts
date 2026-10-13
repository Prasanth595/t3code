import { defineConfig } from "vite-plus";

// The page bundle. Wrangler serves `dist` with Workers Static Assets.
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
});
