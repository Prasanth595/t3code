// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeStreamConsumers from "node:stream/consumers";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: version,
          T3CODE_HOME: NodePath.join(root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed T3 Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed T3 Code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("installer windows shim", () => {
  it("runs from a non-ASCII home and restores codepage 437 on success and failure", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-shim-"));
    const server = NodeHttp.createServer();
    try {
      const home = NodePath.join(root, "Déry home");
      const bin = NodePath.join(root, "bin");
      const version = "1.2.3";
      const stem = `t3-${version}-win32-${HostProcess.Architecture.defaultValue()}`;
      const archiveName = `${stem}.zip`;
      const staging = NodePath.join(root, stem);
      await NodeFSP.mkdir(staging);
      const stubSource = NodePath.join(root, "stub.cs");
      await NodeFSP.writeFile(
        stubSource,
        [
          "public static class Stub {",
          "  public static int Main(string[] args) {",
          '    if (args[0] == "--version") return 0;',
          '    System.Console.WriteLine("ARGS:" + string.Join("|", args));',
          "    return int.Parse(args[0]);",
          "  }",
          "}",
        ].join("\n"),
      );
      const windows = process.env.SystemRoot ?? "C:\\Windows";
      // The .NET Framework compiler ships with Windows; no SDK is needed.
      NodeChildProcess.execFileSync(
        NodePath.join(windows, "Microsoft.NET/Framework/v4.0.30319/csc.exe"),
        ["/nologo", `/out:${NodePath.join(staging, "t3.exe")}`, stubSource],
      );
      NodeChildProcess.execFileSync(NodePath.join(windows, "System32/tar.exe"), [
        "-a",
        "-cf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      server.on("request", (request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (request.url?.endsWith(`/${archiveName}`)) {
          response.writeHead(200, { "Content-Length": archive.length }).end(archive);
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      await new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            NodePath.resolve(import.meta.dirname, "install.ps1"),
          ],
          {
            env: {
              ...process.env,
              NO_COLOR: "1",
              T3CODE_CHANNEL: "stable",
              T3CODE_VERSION: version,
              T3CODE_HOME: home,
              T3CODE_INSTALL_BIN_DIR: bin,
              T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
            timeout: 30_000,
          },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await NodeFSP.writeFile(
        NodePath.join(bin, "run.cmd"),
        [
          "@echo off",
          'for /f "tokens=2 delims=:." %%c in (\'chcp\') do set "TEST_CP=%%c"',
          "chcp 437 >nul",
          "for /f \"tokens=2 delims=:.\" %%c in ('chcp') do echo BEFORE=%%c",
          'set "T3CP=caller-codepage"',
          'set "T3EC=caller-status"',
          'call t3.cmd %1 "one two" three',
          'set "TEST_EXIT=%ERRORLEVEL%"',
          'if not "%T3CP%:%T3EC%"=="caller-codepage:caller-status" exit /b 99',
          "for /f \"tokens=2 delims=:.\" %%c in ('chcp') do echo AFTER=%%c",
          "chcp %TEST_CP% >nul",
          "exit /b %TEST_EXIT%",
          "",
        ].join("\r\n"),
      );
      for (const status of [0, 42]) {
        const child = NodeChildProcess.spawn("cmd.exe", ["/d", "/c", "run.cmd", `${status}`], {
          cwd: bin,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          }),
          NodeStreamConsumers.text(child.stdout),
          NodeStreamConsumers.text(child.stderr),
        ]);
        expect(exitCode, stderr).toBe(status);
        expect(stdout).toContain(`ARGS:${status}|one two|three`);
        expect(stdout).toMatch(/BEFORE=\s*437\r?\n/);
        expect(stdout).toMatch(/AFTER=\s*437\r?\n/);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
