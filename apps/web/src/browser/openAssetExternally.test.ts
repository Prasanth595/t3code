import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  isExternalBrowserFile,
  openAssetExternally,
  openExternalBrowserUrl,
} from "./openAssetExternally";

const openExternal = vi.hoisted(() => vi.fn());
vi.mock("../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
beforeEach(() => {
  openExternal.mockReset();
  vi.unstubAllGlobals();
});
const environmentId = EnvironmentId.make("remote-host");
const resource = {
  _tag: "media-file" as const,
  threadId: ThreadId.make("thread"),
  path: "/exports/report #1.html",
};

it.each([
  "report.html",
  "image.PNG",
  "notes.txt",
  "notes.md",
  "data.csv",
  "data.json",
  "README.text",
  "source.ts",
])("offers browser viewing for %s", (path) => {
  expect(isExternalBrowserFile(path)).toBe(true);
});
it.each(["archive.zip", "program.exe", "folder", "report.html.exe"])(
  "does not offer browser viewing for %s",
  (path) => {
    expect(isExternalBrowserFile(path)).toBe(false);
  },
);
it("mints an exact asset on the source environment and opens through the local browser host", async () => {
  const createAssetUrl = vi
    .fn()
    .mockResolvedValue(
      AsyncResult.success({ relativeUrl: "/api/assets/fresh/report%20%231.html", expiresAt: 1 }),
    );
  await openAssetExternally({
    environmentId,
    resource,
    httpBaseUrl: "https://remote.test",
    createAssetUrl,
  });
  expect(createAssetUrl).toHaveBeenCalledWith({ environmentId, input: { resource } });
  expect(openExternal).toHaveBeenCalledWith(
    "https://remote.test/api/assets/fresh/report%20%231.html",
  );
});
it("does not open after the server refuses a missing or unauthorized file", async () => {
  const createAssetUrl = vi
    .fn()
    .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("File unavailable"))));
  await expect(
    openAssetExternally({
      environmentId,
      resource,
      httpBaseUrl: "https://host.test",
      createAssetUrl,
    }),
  ).rejects.toThrow("File unavailable");
  expect(openExternal).not.toHaveBeenCalled();
});
it.each([
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/html,hello",
  "blob:https://host.test/blob",
])("refuses an OS-incompatible URL %s", async (url) => {
  await expect(openExternalBrowserUrl(url)).rejects.toThrow();
  expect(openExternal).not.toHaveBeenCalled();
});
it("reports a refused OS browser launch", async () => {
  openExternal.mockRejectedValue(new Error("Unable to open link"));
  await expect(openExternalBrowserUrl("https://host.test/report.html")).rejects.toThrow(
    "Unable to open link",
  );
});
it("rechecks filesystem access after minting before opening the local browser", async () => {
  let canRead = true;
  const createAssetUrl = vi.fn(async () => {
    canRead = false;
    return AsyncResult.success({ relativeUrl: "/api/assets/fresh/file.html", expiresAt: 1 });
  });
  await expect(
    openAssetExternally({
      environmentId,
      resource,
      httpBaseUrl: "https://host.test",
      createAssetUrl,
      assertCanOpen: () => {
        if (!canRead) throw new Error("Filesystem access revoked");
      },
    }),
  ).rejects.toThrow("Filesystem access revoked");
  expect(createAssetUrl).toHaveBeenCalledOnce();
  expect(openExternal).not.toHaveBeenCalled();
});

afterEach(() => vi.unstubAllGlobals());

it("reserves a web tab synchronously, removes its opener and navigates only after signing", async () => {
  const tab = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.fn(() => tab);
  vi.stubGlobal("window", { open });
  let finish!: (
    result: ReturnType<
      typeof AsyncResult.success<{
        relativeUrl: string;
        expiresAt: number;
      }>
    >,
  ) => void;
  const createAssetUrl = vi.fn(
    () =>
      new Promise<
        ReturnType<
          typeof AsyncResult.success<{
            relativeUrl: string;
            expiresAt: number;
          }>
        >
      >((resolve) => {
        finish = resolve;
      }),
  );
  const pending = openAssetExternally({
    environmentId,
    resource,
    httpBaseUrl: "https://source.test",
    createAssetUrl,
  });
  expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.replace).not.toHaveBeenCalled();
  finish(AsyncResult.success({ relativeUrl: "/api/assets/fresh/report.html", expiresAt: 1 }));
  await pending;
  expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith(
    "https://source.test/api/assets/fresh/report.html",
  );
  expect(tab.close).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

it("reports a blocked web popup without signing or pretending it opened", async () => {
  vi.stubGlobal("window", { open: vi.fn(() => null) });
  const createAssetUrl = vi.fn();
  await expect(
    openAssetExternally({
      environmentId,
      resource,
      httpBaseUrl: "https://host.test",
      createAssetUrl,
    }),
  ).rejects.toThrow("Allow popups");
  expect(createAssetUrl).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

it("closes a reserved web tab when signing fails", async () => {
  const tab = { opener: {}, close: vi.fn() };
  vi.stubGlobal("window", { open: () => tab });
  const createAssetUrl = vi
    .fn()
    .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Access denied"))));
  await expect(
    openAssetExternally({
      environmentId,
      resource,
      httpBaseUrl: "https://host.test",
      createAssetUrl,
    }),
  ).rejects.toThrow("Access denied");
  expect(tab.close).toHaveBeenCalledOnce();
});
