// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local release-index fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    { matchPage: 1, endPage: 1 },
    { matchPage: 2, endPage: 2 },
    { matchPage: 0, endPage: 2 },
    { matchPage: 0, endPage: 10 },
  ])(
    "resolves stable releases (match page: $matchPage, last page: $endPage)",
    async ({ matchPage, endPage }) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
      const version = "1.2.3";
      const target = NodePath.join(root, "home/runtime/versions", version);
      const pages: number[] = [];
      const server = NodeHttp.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const page = Number(url.searchParams.get("page") ?? "1");
        pages.push(page);
        const releases =
          page === matchPage
            ? [{ tag_name: `v${version}` }]
            : page === endPage && endPage < 10
              ? []
              : Array.from({ length: 100 }, (_, index) => ({
                  tag_name: `v1.2.4-nightly.20261020.${100 - index}`,
                }));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(releases, null, 2));
      });
      try {
        // An existing completed install isolates release resolution from archive downloads.
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
        const source = await NodeFSP.readFile(
          NodePath.resolve(import.meta.dirname, "install.sh"),
          "utf8",
        );
        const installer = NodePath.join(root, "install.sh");
        // Redirect only the API host; keep the installer's real channel lookup intact.
        await NodeFSP.writeFile(
          installer,
          source.replace("https://api.github.com", `http://127.0.0.1:${address.port}`),
        );
        const { code, output } = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = NodeChildProcess.spawn("sh", [installer], {
              env: {
                ...process.env,
                T3CODE_VERSION: "",
                T3CODE_CHANNEL: "stable",
                T3CODE_HOME: NodePath.join(root, "home"),
                T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
          },
        );
        expect(pages).toEqual(Array.from({ length: endPage }, (_, index) => index + 1));
        if (matchPage) {
          expect(code, output).toBe(0);
          expect(output).toContain(`Installed T3 Code ${version}`);
          expect(await NodeFSP.readlink(NodePath.join(root, "bin/t3"))).toBe(
            NodePath.join(target, "t3"),
          );
        } else {
          expect(code).not.toBe(0);
          expect(output).toContain("could not find a stable release; set T3CODE_VERSION");
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
