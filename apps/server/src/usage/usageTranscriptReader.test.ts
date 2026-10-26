// @effect-diagnostics nodeBuiltinImport:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { transcriptLineGate } from "./usageTranscriptReader.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("transcriptLineGate", () => {
  const gates = {
    one: transcriptLineGate(['"usage"']),
    several: transcriptLineGate(['"token_count"', '"session_meta"', '"a.b(c)"']),
  };
  const markers = { one: ['"usage"'], several: ['"token_count"', '"session_meta"', '"a.b(c)"'] };

  it("matches markers beside multi-byte and malformed UTF-8", () => {
    const invalid = Buffer.from([0xff, 0xc3]);
    for (const kind of ["one", "several"] as const) {
      for (const marker of markers[kind]) {
        assert.isTrue(gates[kind](Buffer.from(`{"text":"日本語 é",${marker}:1}`)));
        assert.isTrue(gates[kind](Buffer.concat([invalid, Buffer.from(marker), invalid])));
        assert.isFalse(gates[kind](Buffer.from(`{"text":"日本語 é ${marker.slice(1, -1)}"}`)));
      }
    }
  });
});
