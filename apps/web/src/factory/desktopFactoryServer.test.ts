import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { submitServerAuthCredential } from "../environments/primary/auth";
import { isFactoryServerPrimary, submitFactoryServerPairing } from "./desktopFactoryServer";

const primaryAt = (httpBaseUrl: string) => [
  {
    id: PRIMARY_LOCAL_ENVIRONMENT_ID,
    label: "Primary",
    runningDistro: null,
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace("http", "ws"),
  },
];

const stubWindow = (
  bootstraps: ReadonlyArray<unknown> | null,
  pairFactoryServer = vi.fn().mockResolvedValue(undefined),
) => {
  const reload = vi.fn();
  vi.stubGlobal("window", {
    desktopBridge:
      bootstraps === null ? undefined : { getLocalEnvironmentBootstraps: () => bootstraps },
    t3FactoryDesktop: { pairFactoryServer },
    location: { reload },
  });
  return { pairFactoryServer, reload };
};

describe("desktop factory server pairing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognises a primary environment at the factory server", () => {
    stubWindow(primaryAt("http://127.0.0.1:3876/"));
    expect(isFactoryServerPrimary()).toBe(true);
  });

  it("does not claim a primary environment anywhere else", () => {
    stubWindow(primaryAt("http://127.0.0.1:3880/"));
    expect(isFactoryServerPrimary()).toBe(false);
  });

  it("does not claim a browser tab or a desktop without a primary entry", () => {
    stubWindow(null);
    expect(isFactoryServerPrimary()).toBe(false);
    stubWindow([]);
    expect(isFactoryServerPrimary()).toBe(false);
  });

  it("hands the credential to the desktop and reloads", async () => {
    const { pairFactoryServer, reload } = stubWindow(primaryAt("http://127.0.0.1:3876/"));

    await expect(submitFactoryServerPairing("link")).resolves.toBe(true);

    expect(pairFactoryServer).toHaveBeenCalledWith("link");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("lets a rejected pairing reach the page without reloading", async () => {
    const { reload } = stubWindow(
      primaryAt("http://127.0.0.1:3876/"),
      vi.fn().mockRejectedValue(new Error("The factory server rejected this pairing link.")),
    );

    await expect(submitFactoryServerPairing("stale")).rejects.toThrow(
      "The factory server rejected this pairing link.",
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves other environments to upstream's pairing", async () => {
    const { pairFactoryServer, reload } = stubWindow(primaryAt("http://127.0.0.1:3773/"));

    await expect(submitFactoryServerPairing("link")).resolves.toBe(false);

    expect(pairFactoryServer).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("is what the upstream pairing page submit calls first", async () => {
    const { pairFactoryServer, reload } = stubWindow(primaryAt("http://127.0.0.1:3876/"));

    await submitServerAuthCredential("link");

    expect(pairFactoryServer).toHaveBeenCalledWith("link");
    expect(reload).toHaveBeenCalledOnce();
  });
});
