import { defineConfig, type Plugin } from "vite-plus";

const SERVICE_WORKER = "sw.js";
/** The minifier picks the quote, so the mark of `src/sw/sw.ts` takes any of them. */
const BUILD_FILES_MARKS = ['"', "'", "`"].map((quote) => `[${quote}__BUILD_FILES__${quote}]`);

/**
 * MM-1802: writes the files of this build into `sw.js`. A new build changes `sw.js`, so the
 * browser installs the new worker and drops the files of the old build.
 */
function serviceWorkerFiles(): Plugin {
  return {
    name: "machine-map-service-worker-files",
    apply: "build",
    generateBundle(_options, bundle) {
      const worker = bundle[SERVICE_WORKER];
      if (worker?.type !== "chunk") throw new Error(`The build has no ${SERVICE_WORKER}.`);
      const mark = BUILD_FILES_MARKS.find((candidate) => worker.code.includes(candidate));
      if (!mark) throw new Error(`${SERVICE_WORKER} has no file list.`);
      const files = Object.keys(bundle)
        .filter((name) => name !== SERVICE_WORKER && !name.endsWith(".html"))
        .map((name) => `/${name}`)
        .toSorted();
      worker.code = worker.code.replace(mark, JSON.stringify(files));
    },
  };
}

// The page bundle and the service worker. Wrangler serves `dist` with Workers Static Assets.
export default defineConfig({
  plugins: [serviceWorkerFiles()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: "index.html", sw: "src/sw/sw.ts" },
      output: {
        // The worker keeps a fixed name at the root, so its scope is the whole portal.
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? SERVICE_WORKER : "assets/[name]-[hash].js",
      },
    },
  },
});
