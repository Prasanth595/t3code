// @effect-diagnostics nodeBuiltinImport:off -- The capture worker encodes PNGs with Node's zlib.
import * as NodeZlib from "node:zlib";

import type * as Electron from "electron";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;
const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const BITMAPINFOHEADER_SIZE = 40;

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(NodeZlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** Encode top-down 32-bit BGRA rows, as `GetDIBits` returns them, as an opaque RGB PNG. */
export function encodeBgraPng(bgra: Buffer, width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    let source = y * width * 4;
    let target = y * stride + 1;
    for (let x = 0; x < width; x++, source += 4, target += 3) {
      rows[target] = bgra[source + 2]!;
      rows[target + 1] = bgra[source + 1]!;
      rows[target + 2] = bgra[source]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", NodeZlib.deflateSync(rows, { level: 3 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Load a capture of the Windows desktop in physical pixels, the space
 * `GetWindowRect` reports in a Per-Monitor-V2 process. Electron DIPs cannot
 * describe such a rectangle on mixed-DPI desktops, so it is never converted.
 */
export async function loadWindowsRegionCapture(): Promise<
  (region: Electron.Rectangle) => { width: number; height: number; png: Buffer }
> {
  const { DataType, load, open } = await import("ffi-rs");
  const user32 = "t3-capture-user32";
  const gdi32 = "t3-capture-gdi32";
  open({ library: user32, path: "user32.dll" });
  open({ library: gdi32, path: "gdi32.dll" });
  const handle = (library: string, funcName: string, params: ReadonlyArray<bigint>): bigint =>
    load({
      library,
      funcName,
      retType: DataType.BigInt,
      paramsType: params.map(() => DataType.BigInt),
      paramsValue: [...params],
    }) as bigint;

  return (region) => {
    const width = Math.round(region.width);
    const height = Math.round(region.height);
    if (width <= 0 || height <= 0) throw new Error("Windows window capture region is empty.");
    handle(user32, "SetThreadDpiAwarenessContext", [DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2]);
    const screen = handle(user32, "GetDC", [0n]);
    if (screen === 0n) throw new Error("Windows window capture could not open the desktop.");
    try {
      const memory = handle(gdi32, "CreateCompatibleDC", [screen]);
      if (memory === 0n) throw new Error("Windows window capture could not allocate a surface.");
      try {
        const bitmap = load({
          library: gdi32,
          funcName: "CreateCompatibleBitmap",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt, DataType.I32, DataType.I32],
          paramsValue: [screen, width, height],
        }) as bigint;
        if (bitmap === 0n) throw new Error("Windows window capture could not allocate a bitmap.");
        try {
          const previous = handle(gdi32, "SelectObject", [memory, bitmap]);
          const copied = load({
            library: gdi32,
            funcName: "BitBlt",
            retType: DataType.Boolean,
            paramsType: [
              DataType.BigInt,
              DataType.I32,
              DataType.I32,
              DataType.I32,
              DataType.I32,
              DataType.BigInt,
              DataType.I32,
              DataType.I32,
              DataType.U32,
            ],
            paramsValue: [memory, 0, 0, width, height, screen, region.x, region.y, SRCCOPY],
          });
          // GetDIBits requires the bitmap to be deselected first.
          handle(gdi32, "SelectObject", [memory, previous]);
          if (!copied) throw new Error("Windows window capture failed to copy the screen.");

          const info = Buffer.alloc(BITMAPINFOHEADER_SIZE + 4);
          info.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);
          info.writeInt32LE(width, 4);
          // A negative height requests top-down rows.
          info.writeInt32LE(-height, 8);
          info.writeUInt16LE(1, 12);
          info.writeUInt16LE(32, 14);
          const pixels = Buffer.alloc(width * height * 4);
          const rows = load({
            library: gdi32,
            funcName: "GetDIBits",
            retType: DataType.I32,
            paramsType: [
              DataType.BigInt,
              DataType.BigInt,
              DataType.U32,
              DataType.U32,
              DataType.U8Array,
              DataType.U8Array,
              DataType.U32,
            ],
            paramsValue: [memory, bitmap, 0, height, pixels, info, DIB_RGB_COLORS],
          });
          if (rows !== height) throw new Error("Windows window capture failed to read pixels.");
          return { width, height, png: encodeBgraPng(pixels, width, height) };
        } finally {
          handle(gdi32, "DeleteObject", [bitmap]);
        }
      } finally {
        handle(gdi32, "DeleteDC", [memory]);
      }
    } finally {
      load({
        library: user32,
        funcName: "ReleaseDC",
        retType: DataType.I32,
        paramsType: [DataType.BigInt, DataType.BigInt],
        paramsValue: [0n, screen],
      });
    }
  };
}
