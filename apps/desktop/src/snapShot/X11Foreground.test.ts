import { DataType } from "ffi-rs";
import { describe, expect, it, vi } from "vite-plus/test";

import { readActiveX11Window, readX11ActiveWindow, type X11WindowReader } from "./X11Foreground.ts";

const openLibrary = vi.hoisted(() => vi.fn());
const loadNative = vi.hoisted(() =>
  vi.fn<(params: Parameters<typeof import("ffi-rs").load>[0]) => unknown>(),
);
vi.mock("ffi-rs", async (importOriginal) => {
  const ffi = await importOriginal<typeof import("ffi-rs")>();
  return { DataType: ffi.DataType, open: openLibrary, load: loadNative };
});

it("preserves native library failures for capture diagnostics", async () => {
  openLibrary.mockImplementation(() => {
    throw new Error("missing libX11");
  });
  await expect(readActiveX11Window()).rejects.toThrow("missing libX11");
});

function reader(overrides: Partial<X11WindowReader> = {}): X11WindowReader {
  return {
    rootWindow: () => 1,
    activeWindow: () => 0,
    focusWindow: () => 0,
    parentWindow: () => 1,
    hasWmState: () => false,
    bounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    title: () => "Editor",
    processId: () => 123,
    appName: () => "Text Editor",
    ...overrides,
  };
}

describe("readX11ActiveWindow", () => {
  it("reads the EWMH active window without consulting keyboard focus", () => {
    const focusWindow = vi.fn(() => 9);
    expect(
      readX11ActiveWindow(
        reader({
          activeWindow: () => 42,
          focusWindow,
        }),
      ),
    ).toEqual({
      id: 42,
      title: "Editor",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      processId: 123,
      appName: "Text Editor",
    });
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it("walks focus up to the client window that owns WM_STATE", () => {
    const parents = new Map([
      [100, 200],
      [200, 42],
      [42, 1],
    ]);
    expect(
      readX11ActiveWindow(
        reader({
          focusWindow: () => 100,
          parentWindow: (window) => parents.get(window),
          hasWmState: (window) => window === 42,
        }),
      )?.id,
    ).toBe(42);
  });

  it("uses the top-level window when no ancestor exposes WM_STATE", () => {
    const parents = new Map([
      [100, 200],
      [200, 1],
    ]);
    expect(
      readX11ActiveWindow(
        reader({
          focusWindow: () => 100,
          parentWindow: (window) => parents.get(window),
        }),
      )?.id,
    ).toBe(200);
  });

  it("ignores None and PointerRoot focus", () => {
    expect(readX11ActiveWindow(reader({ focusWindow: () => 0 }))).toBeUndefined();
    expect(readX11ActiveWindow(reader({ focusWindow: () => 1 }))).toBeUndefined();
  });

  it("does not return a window whose geometry is unavailable", () => {
    expect(
      readX11ActiveWindow(
        reader({
          activeWindow: () => 42,
          bounds: () => undefined,
        }),
      ),
    ).toBeUndefined();
  });
});

function nativeFixture({ wrongActiveType = false, failGeometry = false } = {}) {
  openLibrary.mockReset();
  const atoms = new Map<string, number>();
  const atom = (name: string) => {
    if (!atoms.has(name)) atoms.set(name, atoms.size + 1);
    return atoms.get(name)!;
  };
  const long = (value: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    return bytes;
  };
  const properties = new Map([
    [atom("_NET_ACTIVE_WINDOW"), { type: atom("WINDOW"), format: 32, bytes: long(42) }],
    [atom("_NET_WM_PID"), { type: atom("CARDINAL"), format: 32, bytes: long(123) }],
    [atom("_NET_WM_NAME"), { type: atom("UTF8_STRING"), format: 8, bytes: Buffer.from("Editor") }],
    [
      atom("WM_CLASS"),
      { type: atom("STRING"), format: 8, bytes: Buffer.from("editor\0Text Editor\0") },
    ],
  ]);
  const allocations = new Map<number, Buffer>();
  const freed: number[] = [];
  const closed = vi.fn();
  loadNative.mockImplementation(({ library, funcName, paramsValue: args }) => {
    const out = (index: number) => args[index] as Buffer;
    switch (funcName) {
      case "XOpenDisplay":
        return 100;
      case "XDefaultRootWindow":
        return 1;
      case "XInternAtom":
        return atom(String(args[1]));
      case "XGetWindowProperty": {
        const value = properties.get(Number(args[2]));
        if (!value) return 0;
        const address = allocations.size + 1000;
        allocations.set(address, value.bytes);
        out(7).writeBigUInt64LE(
          BigInt(
            wrongActiveType && args[2] === atom("_NET_ACTIVE_WINDOW") ? atom("STRING") : value.type,
          ),
        );
        out(8).writeInt32LE(value.format);
        out(9).writeBigUInt64LE(
          BigInt(value.format === 32 ? value.bytes.length / 8 : value.bytes.length),
        );
        out(11).writeBigUInt64LE(BigInt(address));
        return 0;
      }
      case "memcpy": {
        expect(library).toBe("t3-libc");
        allocations.get(Number(args[1]))!.copy(out(0), 0, 0, Number(args[2]));
        return 0;
      }
      case "XFree":
        freed.push(Number(args[0]));
        return 0;
      case "XGetInputFocus":
        return 0;
      case "XGetGeometry":
        if (failGeometry) throw new Error("geometry lookup failed");
        out(5).writeUInt32LE(800);
        out(6).writeUInt32LE(600);
        return 1;
      case "XTranslateCoordinates":
        out(5).writeInt32LE(-800);
        out(6).writeInt32LE(20);
        return 1;
      case "XCloseDisplay":
        closed();
        return 0;
      default:
        throw new Error(`Unexpected native call: ${funcName}`);
    }
  });
  return { closed, freed, allocations };
}

it("decodes native property buffers and frees every Xlib allocation", async () => {
  const fixture = nativeFixture();
  expect(await readActiveX11Window()).toEqual({
    id: 42,
    title: "Editor",
    processId: 123,
    appName: "Text Editor",
    bounds: { x: -800, y: 20, width: 800, height: 600 },
  });
  expect(fixture.freed).toEqual([...fixture.allocations.keys()]);
  expect(fixture.closed).toHaveBeenCalledOnce();
  const geometryCall = loadNative.mock.calls.find(
    ([call]) => call.funcName === "XGetGeometry",
  )?.[0];
  expect(geometryCall?.paramsType).toEqual([
    DataType.U64,
    DataType.U64,
    ...Array(7).fill(DataType.U8Array),
  ]);
});

it("rejects a wrongly typed active-window property and still frees its memory", async () => {
  const fixture = nativeFixture({ wrongActiveType: true });
  expect(await readActiveX11Window()).toBeUndefined();
  expect(fixture.freed).toEqual([...fixture.allocations.keys()]);
  expect(fixture.closed).toHaveBeenCalledOnce();
});

it("closes the display when a native read fails", async () => {
  const fixture = nativeFixture({ failGeometry: true });
  await expect(readActiveX11Window()).rejects.toThrow("geometry lookup failed");
  expect(fixture.closed).toHaveBeenCalledOnce();
});
