import { describe, expect, it } from "vite-plus/test";

import { parseLfsPointer } from "./gitLfs.ts";

const oid = "ab".repeat(32);
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123\n`;

describe("parseLfsPointer", () => {
  it("reads complete v1 pointers with or without the final newline", () => {
    expect(parseLfsPointer(pointer)).toEqual({ oid, size: 123 });
    expect(parseLfsPointer(pointer.trimEnd())).toEqual({ oid, size: 123 });
    expect(parseLfsPointer(pointer.replace("size 123", "size 0"))).toEqual({ oid, size: 0 });
  });

  it.each([
    pointer.replace("sha256:", "sha1:"),
    pointer.replace(oid, "../outside"),
    pointer.replace(oid, oid.toUpperCase()),
    pointer.replace(oid, oid.slice(1)),
    pointer.replace("size 123", "size -1"),
    pointer.replace("size 123", "size 0123"),
    pointer.replace("size 123", "size 9007199254740992"),
    pointer.replace("oid ", "ext-0-transform sha256:abc\noid "),
    pointer + "unexpected\n",
    pointer.repeat(10),
    pointer.replace(/\n/g, "\r\n"),
  ])("leaves unsupported or malformed content as text: %j", (contents) => {
    expect(parseLfsPointer(contents)).toBeNull();
  });
});
