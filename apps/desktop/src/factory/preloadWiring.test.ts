// Loads the real preload with Electron's renderer API faked, to prove it still calls the factory
// bridge. A deleted `exposeFactoryDesktopBridge()` leaves the pairing page without its button.
import { afterAll, expect, it, vi } from "vite-plus/test";

const exposeFactoryDesktopBridge = vi.hoisted(() => vi.fn());
vi.mock("./preloadBridge.ts", () => ({ exposeFactoryDesktopBridge }));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { sendSync: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webFrame: { getZoomFactor: () => 1 },
  webUtils: { getPathForFile: vi.fn() },
}));

// The preload runs in a renderer; the tests run in Node. These cover the few DOM calls it
// makes while loading.
vi.stubGlobal("window", { addEventListener: vi.fn(), localStorage: {} });
vi.stubGlobal("document", { documentElement: { style: { setProperty: vi.fn() } } });
afterAll(() => vi.unstubAllGlobals());

it("the preload exposes the factory desktop bridge once", async () => {
  await import("../preload.ts");
  expect(exposeFactoryDesktopBridge).toHaveBeenCalledTimes(1);
});
