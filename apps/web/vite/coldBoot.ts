import * as NodeURL from "node:url";
import { minify, type HtmlTagDescriptor, type Plugin } from "vite-plus";

/** Coalesce startup imports without pulling dynamic panels or icon pickers into boot. */
export function coldBootPlugin(): Plugin {
  const chatModules = new Set<string>();
  let base = "/";
  return {
    name: "t3code:cold-boot",
    apply: "build",
    config: () => ({
      build: {
        rolldownOptions: {
          // An explicit main entry lets Rolldown identify its live static dependencies
          // after tree shaking. Bootstrap still imports it dynamically.
          input: [
            NodeURL.fileURLToPath(new URL("../index.html", import.meta.url)),
            NodeURL.fileURLToPath(new URL("../src/main.tsx", import.meta.url)),
          ],
          output: {
            codeSplitting: {
              groups: [
                { name: "boot", tags: ["$initial"], minShareCount: 2 },
                { name: "chat", test: (id) => chatModules.has(id), minShareCount: 2 },
              ],
            },
          },
        },
      },
    }),
    configResolved(config) {
      base = config.base;
    },
    buildEnd(error) {
      chatModules.clear();
      if (error) return;
      const visit = (id: string, modules: Set<string>) => {
        if (modules.has(id)) return;
        modules.add(id);
        for (const dependency of this.getModuleInfo(id)?.importedIds ?? []) {
          visit(dependency, modules);
        }
      };
      for (const id of this.getModuleIds()) {
        const normalized = id.replaceAll("\\", "/");
        if (normalized.endsWith("/apps/web/src/components/ChatView.tsx")) visit(id, chatModules);
      }
    },
    transformIndexHtml: {
      order: "post",
      async handler(html, context) {
        const bundle = context.bundle;
        if (!bundle) return;
        const files = new Set<string>();
        const styles = new Set<string>();
        const visit = (fileName: string) => {
          if (files.has(fileName)) return;
          const chunk = bundle[fileName];
          if (chunk?.type !== "chunk") return;
          files.add(fileName);
          for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css);
          for (const dependency of chunk.imports) visit(dependency);
        };
        for (const chunk of Object.values(bundle)) {
          if (
            chunk.type === "chunk" &&
            /\/apps\/web\/src\/(?:main\.tsx|components\/CommandPalette\.tsx|observability\/clientTracing\.ts|routes\/_chat(?:\.\$environmentId\.\$threadId)?\.tsx\?tsr-split=component)$/.test(
              chunk.facadeModuleId?.replaceAll("\\", "/") ?? "",
            )
          ) {
            visit(chunk.fileName);
          }
        }
        // Tracing and palette content can download alongside boot without being evaluated.
        // Preload startup and thread imports without following lazy panels.
        const missing = (fileName: string) => !html.includes(`href="${base}${fileName}"`);
        const tags: HtmlTagDescriptor[] = [
          ...[...files].filter(missing).map((fileName) => ({
            tag: "link",
            attrs: { rel: "modulepreload", crossorigin: "", href: `${base}${fileName}` },
            injectTo: "head" as const,
          })),
          ...[...styles].filter(missing).map((fileName) => ({
            tag: "link",
            attrs: { rel: "preload", as: "style", crossorigin: "", href: `${base}${fileName}` },
            injectTo: "head" as const,
          })),
        ];
        // Inline startup scripts ship on every HTML load.
        for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
          const result = await minify("boot.js", match[1]!);
          if (result.errors.length) throw new Error("Could not minify boot script.");
          html = html.replace(match[0], `<script>${result.code}</script>`);
        }
        return { html, tags };
      },
    },
  };
}
