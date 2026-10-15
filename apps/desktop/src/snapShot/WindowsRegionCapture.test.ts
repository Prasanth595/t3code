import * as NodeZlib from "node:zlib";

import { assert, it } from "vite-plus/test";

import { encodeBgraPng } from "./WindowsRegionCapture.ts";

it("encodes top-down BGRA rows as an RGB PNG", () => {
  // 2x2: blue, green / red, white, with junk in the unused alpha byte.
  const bgra = Buffer.from([255, 0, 0, 7, 0, 255, 0, 7, 0, 0, 255, 7, 255, 255, 255, 7]);

  const png = encodeBgraPng(bgra, 2, 2);

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
  assert.deepEqual([...png.subarray(24, 26)], [8, 2]);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.toString("latin1", 37, 41), "IDAT");
  assert.equal(
    png.readUInt32BE(41 + idatLength),
    NodeZlib.crc32(png.subarray(37, 41 + idatLength)),
  );
  assert.deepEqual(
    [...NodeZlib.inflateSync(png.subarray(41, 41 + idatLength))],
    [0, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 255, 255],
  );
  assert.equal(png.toString("latin1", png.length - 8, png.length - 4), "IEND");
});
