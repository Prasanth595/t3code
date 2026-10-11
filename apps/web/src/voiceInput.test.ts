import { describe, expect, it } from "vite-plus/test";

import { encodePcm16 } from "./voiceInput";

describe("encodePcm16", () => {
  it("writes clamped little-endian 16-bit samples", () => {
    const view = new DataView(encodePcm16(new Float32Array([0, 1, -1, 0.5, 2, -3])).buffer);
    const samples = Array.from({ length: 6 }, (_, index) => view.getInt16(index * 2, true));
    expect(samples).toEqual([0, 32767, -32767, 16384, 32767, -32767]);
  });
});
