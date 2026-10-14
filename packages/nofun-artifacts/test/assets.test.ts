import assert from "node:assert/strict";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";

import { inlineAssets } from "../src/live/assets.ts";

test("inlineAssets keeps the page brand's images first and counts encoded bytes against the room", () => {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "nf-assets-"));
  for (const brand of ["mrch", "onlycolor"]) {
    NodeFs.mkdirSync(NodePath.join(dir, "public", "brands", brand), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(dir, "public", "brands", brand, "a.png"), Buffer.alloc(3000));
  }
  const paths = ["/brands/onlycolor/a.png", "/brands/mrch/a.png"];
  // 3000 raw bytes are 4000 base64 characters plus the data URI prefix: room for one, not two.
  const one = inlineAssets(dir, paths, "mrch", 6000);
  assert.deepEqual(Object.keys(one.map), ["brands/mrch/a.png"]);
  assert.deepEqual(one.skipped, ["/brands/onlycolor/a.png"]);
  assert.equal(one.bytes, one.map["brands/mrch/a.png"]!.length);

  const both = inlineAssets(dir, paths, "mrch", 9000);
  assert.equal(Object.keys(both.map).length, 2);
  assert.deepEqual(both.skipped, []);
  NodeFs.rmSync(dir, { recursive: true, force: true });
});
