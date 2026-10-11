// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as HostProcess from "./HostProcess.ts";

const mutableOs = NodeModule.createRequire(import.meta.url)("node:os") as typeof NodeOS;

afterEach(() => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
});

describe("Username", () => {
  it("uses the OS login account", () => {
    const userInfo = NodeOS.userInfo();
    vi.spyOn(mutableOs, "userInfo").mockReturnValue({ ...userInfo, username: " remote-user " });
    NodeModule.syncBuiltinESMExports();
    expect(HostProcess.Username.defaultValue()).toBe("remote-user");
  });

  it("leaves the username unavailable when the OS lookup fails", () => {
    vi.spyOn(mutableOs, "userInfo").mockImplementation(() => {
      throw new Error("No passwd entry for this UID");
    });
    NodeModule.syncBuiltinESMExports();
    expect(HostProcess.Username.defaultValue()).toBeNull();
  });

  it("leaves an empty username unavailable", () => {
    const userInfo = NodeOS.userInfo();
    vi.spyOn(mutableOs, "userInfo").mockReturnValue({ ...userInfo, username: " " });
    NodeModule.syncBuiltinESMExports();
    expect(HostProcess.Username.defaultValue()).toBeNull();
  });
});
