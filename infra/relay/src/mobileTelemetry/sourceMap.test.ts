import { describe, expect, it } from "@effect/vitest";

import { decodeSourceMap, symbolicateStack } from "./sourceMap.ts";

/**
 * `hermesc -O -emit-binary -output-source-map` output for this `t.js`, and the
 * stack the Hermes VM printed running it. Real Hermes output pins the
 * convention that a frame's column is the map's 0-based generated column.
 *
 *     function alpha() {
 *       throw new Error("boom");
 *     }
 *     function beta() {
 *       return 1 + alpha();
 *     }
 *     function gamma() {
 *       try { beta(); } catch (e) { print(e.stack); }
 *     }
 *     gamma();
 */
const HERMES_MAP = {
  version: 3,
  sources: ["t.js"],
  mappings:
    "AAAA,iBAAA,OAAA,MAAA,KAAA,MAAA,KAAA,MASA,OAAK,IAAE,EATP,EACY,MAAK,KAAA,WAAA,IAAA,IAAf,EAEF,EACa,OAAK,OAAT,IAAP,EAEF,AACE,EAAM,OAAI,IAAI,EAAE,IAAY,MAAO,OAAF,KAAW,EAC9C;",
  x_hermes_function_offsets: { "0": [0, 65, 99, 121] },
};
const HERMES_STACK = [
  "Error: boom",
  "    at alpha (address at t.hbc:1:89)",
  "    at beta (address at t.hbc:1:108)",
  "    at gamma (address at t.hbc:1:130)",
  "    at global (address at t.hbc:1:59)",
].join("\n");

describe("symbolicateStack", () => {
  it("rewrites Hermes bundle frames to their original locations and keeps the rest", () => {
    const map = decodeSourceMap(HERMES_MAP)!;
    const result = symbolicateStack(
      `${HERMES_STACK}\n    at apply (native)\n    at tryCallOne (address at InternalBytecode.js:1:89)`,
      map,
      Number.POSITIVE_INFINITY,
    );
    expect(result).toEqual({
      stack: [
        "Error: boom",
        "    at alpha (t.js:2:18)",
        "    at beta (t.js:5:19)",
        "    at gamma (t.js:8:13)",
        "    at global (t.js:10:6)",
        "    at apply (native)",
        "    at tryCallOne (address at InternalBytecode.js:1:89)",
      ].join("\n"),
      bundleFrames: 4,
      mappedFrames: 4,
      growth: -50,
    });
  });
});
