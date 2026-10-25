import { describe, expect, it, vi } from "vite-plus/test";
import { supportsNativeTerminalOutput } from "./nativeTerminalModule";
const native = vi.hoisted(() => ({ module: null as { outputRevision?: number } | null }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => native.module,
  requireNativeView: vi.fn(),
}));

describe("native terminal output capability", () => {
  it("uses legacy output for installed binaries without the streaming revision", () => {
    native.module = null;
    expect(supportsNativeTerminalOutput()).toBe(false);
    native.module = {};
    expect(supportsNativeTerminalOutput()).toBe(false);
    native.module = { outputRevision: 1 };
    expect(supportsNativeTerminalOutput()).toBe(true);
    native.module = { outputRevision: 2 };
    expect(supportsNativeTerminalOutput()).toBe(false);
  });
});
