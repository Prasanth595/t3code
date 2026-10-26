// @effect-diagnostics nodeBuiltinImport:off -- This worker boundary checks the native Xlib ABI.

import * as NodeOS from "node:os";

type Ffi = Pick<typeof import("ffi-rs"), "DataType" | "load" | "open">;
type FfiLoadParams = Parameters<Ffi["load"]>[0];

const X11_LIBRARY = "t3-x11";
const LIBC_LIBRARY = "t3-libc";
const MAX_PROPERTY_LENGTH = 1_024;
const MAX_PROPERTY_BYTES = 65_536;
const MAX_WINDOW_DEPTH = 64;

export type X11WindowBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type X11ActiveWindow = {
  readonly id: number;
  readonly title: string;
  readonly bounds: X11WindowBounds;
  readonly processId: number;
  readonly appName: string;
};

export interface X11WindowReader {
  readonly rootWindow: () => number;
  readonly activeWindow: () => number;
  readonly focusWindow: () => number;
  readonly parentWindow: (window: number) => number | undefined;
  readonly hasWmState: (window: number) => boolean;
  readonly bounds: (window: number) => X11WindowBounds | undefined;
  readonly title: (window: number) => string;
  readonly processId: (window: number) => number;
  readonly appName: (window: number) => string;
}

export function readX11ActiveWindow(reader: X11WindowReader): X11ActiveWindow | undefined {
  const root = reader.rootWindow();
  const active = reader.activeWindow();
  const window = active > 1 && active !== root ? active : resolveFocusedWindow(reader, root);
  if (window === undefined) return undefined;
  const bounds = reader.bounds(window);
  if (!bounds) return undefined;
  return {
    id: window,
    title: reader.title(window),
    bounds,
    processId: reader.processId(window),
    appName: reader.appName(window),
  };
}

function resolveFocusedWindow(reader: X11WindowReader, root: number): number | undefined {
  let window = reader.focusWindow();
  if (window <= 1) return undefined;
  for (let depth = 0; depth < MAX_WINDOW_DEPTH; depth++) {
    if (reader.hasWmState(window)) return window;
    const parent = reader.parentWindow(window);
    if (!parent || parent === window) return window === root ? undefined : window;
    if (parent === root) return window;
    window = parent;
  }
  return window === root ? undefined : window;
}

async function loadX11(): Promise<Ffi> {
  const ffi = await import("ffi-rs");
  ffi.open({ library: X11_LIBRARY, path: "libX11.so.6" });
  ffi.open({ library: LIBC_LIBRARY, path: "libc.so.6" });
  return ffi;
}

export async function readActiveX11Window(): Promise<X11ActiveWindow | undefined> {
  // Xlib can exit on protocol errors; call this only from the isolated lookup worker.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The isolated native worker validates its own ABI before allocating Xlib buffers.
  const architecture = NodeOS.arch();
  if ((architecture !== "x64" && architecture !== "arm64") || NodeOS.endianness() !== "LE") {
    throw new Error(`Unsupported X11 architecture: ${architecture} ${NodeOS.endianness()}`);
  }
  const ffi = await loadX11();
  const { DataType, load } = ffi;
  const display = load({
    library: X11_LIBRARY,
    funcName: "XOpenDisplay",
    retType: DataType.U64,
    paramsType: [DataType.BigInt],
    paramsValue: [0n],
  }) as number;
  if (!display) throw new Error("Could not open the X11 display.");
  try {
    const root = load({
      library: X11_LIBRARY,
      funcName: "XDefaultRootWindow",
      retType: DataType.U64,
      paramsType: [DataType.U64],
      paramsValue: [display],
    }) as number;
    return root ? readX11ActiveWindow(makeReader(ffi, display, root)) : undefined;
  } finally {
    load({
      library: X11_LIBRARY,
      funcName: "XCloseDisplay",
      retType: DataType.I32,
      paramsType: [DataType.U64],
      paramsValue: [display],
    });
  }
}

type X11Property = {
  readonly format: number;
  readonly bytes: Buffer;
};

function makeReader(ffi: Ffi, display: number, root: number): X11WindowReader {
  const { DataType, load } = ffi;
  const atoms = new Map<string, number>();

  const call = (
    funcName: string,
    retType: FfiLoadParams["retType"],
    paramsType: FfiLoadParams["paramsType"],
    paramsValue: unknown[],
  ) => load({ library: X11_LIBRARY, funcName, retType, paramsType, paramsValue });
  const intern = (name: string) => {
    let atom = atoms.get(name);
    if (atom === undefined) {
      atom = call(
        "XInternAtom",
        DataType.U64,
        [DataType.U64, DataType.String, DataType.I32],
        [display, name, 0],
      ) as number;
      atoms.set(name, atom);
    }
    return atom;
  };
  const property = (window: number, name: string, type: string): X11Property | undefined => {
    const atom = intern(name);
    if (!atom) return undefined;
    const actualType = Buffer.alloc(8);
    const actualFormat = Buffer.alloc(4);
    const itemCount = Buffer.alloc(8);
    const bytesAfter = Buffer.alloc(8);
    const value = Buffer.alloc(8);
    const status = call(
      "XGetWindowProperty",
      DataType.I32,
      [
        DataType.U64,
        DataType.U64,
        DataType.U64,
        DataType.U64,
        DataType.U64,
        DataType.I32,
        DataType.U64,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
      ],
      [
        display,
        window,
        atom,
        0,
        MAX_PROPERTY_LENGTH,
        0,
        intern(type),
        actualType,
        actualFormat,
        itemCount,
        bytesAfter,
        value,
      ],
    ) as number;
    if (status !== 0) return undefined;
    const address = value.readBigUInt64LE(0);
    if (!address) return undefined;
    try {
      if (Number(actualType.readBigUInt64LE(0)) !== intern(type)) return undefined;
      const format = actualFormat.readInt32LE(0);
      const count = Number(itemCount.readBigUInt64LE(0));
      const length =
        format === 32 ? count * 8 : format === 16 ? count * 2 : format === 8 ? count : 0;
      const bytes = Buffer.alloc(Math.min(length, MAX_PROPERTY_BYTES));
      if (bytes.length > 0) {
        load({
          library: LIBC_LIBRARY,
          funcName: "memcpy",
          retType: DataType.U64,
          paramsType: [DataType.U8Array, DataType.U64, DataType.U64],
          paramsValue: [bytes, Number(address), bytes.length],
        });
      }
      return { format, bytes };
    } finally {
      call("XFree", DataType.I32, [DataType.U64], [Number(address)]);
    }
  };
  const propertyString = (window: number, name: string, type: string): string => {
    const value = property(window, name, type);
    return value?.format === 8 ? (value.bytes.toString("utf8").split("\0")[0] ?? "") : "";
  };
  const propertyNumber = (window: number, name: string, type: string): number => {
    const value = property(window, name, type);
    return value?.format === 32 && value.bytes.length >= 8 ? value.bytes.readUInt32LE(0) : 0;
  };
  const getGeometry = (window: number): X11WindowBounds | undefined => {
    const rootReturn = Buffer.alloc(8);
    const x = Buffer.alloc(4);
    const y = Buffer.alloc(4);
    const width = Buffer.alloc(4);
    const height = Buffer.alloc(4);
    const borderWidth = Buffer.alloc(4);
    const depth = Buffer.alloc(4);
    const ok = call(
      "XGetGeometry",
      DataType.I32,
      [
        DataType.U64,
        DataType.U64,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
      ],
      [display, window, rootReturn, x, y, width, height, borderWidth, depth],
    ) as number;
    if (!ok) return undefined;
    const destinationX = Buffer.alloc(4);
    const destinationY = Buffer.alloc(4);
    const child = Buffer.alloc(8);
    const translated = call(
      "XTranslateCoordinates",
      DataType.I32,
      [
        DataType.U64,
        DataType.U64,
        DataType.U64,
        DataType.I32,
        DataType.I32,
        DataType.U8Array,
        DataType.U8Array,
        DataType.U8Array,
      ],
      [display, window, root, 0, 0, destinationX, destinationY, child],
    ) as number;
    if (!translated) return undefined;
    const size = { width: width.readUInt32LE(0), height: height.readUInt32LE(0) };
    return size.width > 0 && size.height > 0
      ? { x: destinationX.readInt32LE(0), y: destinationY.readInt32LE(0), ...size }
      : undefined;
  };

  return {
    rootWindow: () => root,
    activeWindow: () => propertyNumber(root, "_NET_ACTIVE_WINDOW", "WINDOW"),
    focusWindow: () => {
      const focus = Buffer.alloc(8);
      const revertTo = Buffer.alloc(4);
      call(
        "XGetInputFocus",
        DataType.I32,
        [DataType.U64, DataType.U8Array, DataType.U8Array],
        [display, focus, revertTo],
      );
      return Number(focus.readBigUInt64LE(0));
    },
    parentWindow: (window) => {
      const rootReturn = Buffer.alloc(8);
      const parent = Buffer.alloc(8);
      const children = Buffer.alloc(8);
      const childCount = Buffer.alloc(4);
      const ok = call(
        "XQueryTree",
        DataType.I32,
        [
          DataType.U64,
          DataType.U64,
          DataType.U8Array,
          DataType.U8Array,
          DataType.U8Array,
          DataType.U8Array,
        ],
        [display, window, rootReturn, parent, children, childCount],
      ) as number;
      if (!ok) return undefined;
      const childrenAddress = children.readBigUInt64LE(0);
      if (childrenAddress) {
        call("XFree", DataType.I32, [DataType.U64], [Number(childrenAddress)]);
      }
      return Number(parent.readBigUInt64LE(0));
    },
    hasWmState: (window) => (property(window, "WM_STATE", "WM_STATE")?.bytes.length ?? 0) > 0,
    bounds: getGeometry,
    title: (window) =>
      propertyString(window, "_NET_WM_NAME", "UTF8_STRING") ||
      propertyString(window, "WM_NAME", "STRING"),
    processId: (window) => propertyNumber(window, "_NET_WM_PID", "CARDINAL"),
    appName: (window) => {
      const value = property(window, "WM_CLASS", "STRING");
      if (value?.format !== 8) return "";
      const names = value.bytes
        .toString("utf8")
        .split("\0")
        .map((name) => name.trim())
        .filter(Boolean);
      return names.at(-1) ?? "";
    },
  };
}
