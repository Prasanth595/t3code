// @effect-diagnostics nodeBuiltinImport:off - expectations mirror the host path joins the script under test performs.
import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";

import {
  encodeAndroidPairingUrls,
  normalizeStorePng,
  parsePairingCredentialOutput,
  readPngMetadata,
  validateStoreAsset,
} from "./mobile-showcase.ts";

const storeAsset = {
  store: "apple" as const,
  directory: "apple/test",
  width: 2,
  height: 3,
  minimumUploadCount: 1,
  maximumUploadCount: 10,
};

function rgbaPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

it("converts simulator RGBA captures to upload-safe 24-bit RGB PNGs", () => {
  const normalized = normalizeStorePng(rgbaPng(2, 3));
  assert.deepStrictEqual(readPngMetadata(normalized), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

it("reads multiline JSON from the pairing CLI", () => {
  assert.equal(
    parsePairingCredentialOutput('server log\n{\n  "credential": "PAIR-ME"\n}\n'),
    "PAIR-ME",
  );
});

it("encodes Android pairing URLs without shell-sensitive JSON quotes", () => {
  const urls = ["http://10.0.2.2:65164/#token=ONE", "http://10.0.2.2:65198/#token=TWO"];
  const encoded = encodeAndroidPairingUrls(urls);
  assert.equal(encoded.startsWith("json-uri:"), true);
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(encoded.slice("json-uri:".length))), urls);
  assert.equal(encoded.includes('"'), false);
});

it("accepts a complete RGB PNG as a store asset", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  assert.doesNotThrow(() => validateStoreAsset(storeAsset, bytes, "thread.png"));
});

it.each([26, 44])("rejects a store PNG truncated to %i bytes", (length) => {
  const bytes = normalizeStorePng(rgbaPng(2, 3)).subarray(0, length);
  assert.throws(
    () => validateStoreAsset(storeAsset, bytes, "thread.png"),
    /thread\.png.*valid PNG/,
  );
});

it("rejects a store PNG with a damaged chunk checksum", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  bytes.writeUInt32BE((bytes.readUInt32BE(29) ^ 1) >>> 0, 29);
  assert.throws(
    () => validateStoreAsset(storeAsset, bytes, "thread.png"),
    /thread\.png.*valid PNG/,
  );
});
