// @effect-diagnostics nodeBuiltinImport:off - The test holds a real socket and runs the real CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too. macOS needs neither.
const MACOS_BIND_PRELOAD = `const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  if (typeof port !== "number" || typeof host !== "string") return listen.apply(this, arguments);
  return listen.call(this, { port, host, reusePort: true }, callback);
};
`;

describe("__ssh-helper pick-port", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const linuxHost = hostPlatform === "linux";

  it.skipIf(hostPlatform === "win32")(
    "skips a port another server answers on loopback",
    async () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pick-port-"));
      const holder = NodeNet.createServer((socket) => socket.destroy());
      try {
        const preload = NodePath.join(root, "preload.cjs");
        NodeFS.writeFileSync(preload, MACOS_BIND_PRELOAD);
        await new Promise<void>((resolve, reject) => {
          holder.once("error", reject);
          holder.listen({ port: 0, host: "0.0.0.0", reusePort: linuxHost }, resolve);
        });
        const heldPort = (holder.address() as NodeNet.AddressInfo).port;

        const { stdout } = await execFile(process.execPath, [
          ...(linuxHost ? ["--require", preload] : []),
          new URL("../bin.ts", import.meta.url).pathname,
          "__ssh-helper",
          "pick-port",
          "",
          String(heldPort),
          "20",
        ]);

        const picked = Number(stdout);
        expect(picked).toBeGreaterThan(heldPort);
        expect(picked).toBeLessThan(heldPort + 20);
      } finally {
        await new Promise((resolve) => holder.close(resolve));
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
