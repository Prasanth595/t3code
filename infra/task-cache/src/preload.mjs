import * as NodeModule from "node:module";

// Older Node processes in unrelated projects must remain unaffected by machine setup.
if (
  typeof NodeModule.registerHooks === "function" &&
  Number(process.versions.node.split(".")[0]) >= 24
) {
  const { patchNativeCli } = await import("./nativeHook.js");
  const hookUrl = new URL("./nativeRunHook.js", import.meta.url).href;
  NodeModule.registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith("/vite-plus/dist/bin.js")) return loaded;
      try {
        const source =
          typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString();
        return {
          ...loaded,
          source: patchNativeCli(source).replace(
            'from "./run-hook.js"',
            `from ${JSON.stringify(hookUrl)}`,
          ),
        };
      } catch {
        process.stderr.write(
          "Task cache hook does not support this Vite+ version; running without telemetry.\n",
        );
        return loaded;
      }
    },
  });
}
