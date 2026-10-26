// @effect-diagnostics nodeBuiltinImport:off - exercise the real byte reader.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { TEST_FORMATS } from "./usageTestFormats.ts";
import {
  readTranscriptRecords as readWithDefaultThreshold,
  type TranscriptParsePosition,
} from "./usageTranscriptReader.ts";

const readTranscriptRecords = (
  path: string,
  provider: keyof typeof TEST_FORMATS,
  position?: TranscriptParsePosition,
) =>
  readWithDefaultThreshold(path, TEST_FORMATS[provider], position, {
    streamingThresholdBytes: 256 * 1024,
  });

let dir: string;
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-stream-"));
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const timestamp = "2026-08-01T10:00:00Z";
const content = '工具 output \\" usage token_count '.repeat(40_000);
async function scan(
  lines: readonly unknown[],
  provider: keyof typeof TEST_FORMATS,
  name = "history",
) {
  const path = NodePath.join(dir, `${name}.jsonl`);
  await NodeFSP.writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const result = await readTranscriptRecords(path, provider);
  expect(result).not.toBeNull();
  return result!;
}

describe("large usage records", () => {
  it("keeps Pi model, cost, and fork identity after large assistant content", async () => {
    const entry = {
      type: "message",
      id: "a123abcd",
      timestamp,
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "requested",
        responseModel: "actual",
        content: [{ type: "text", text: content }],
        usage: {
          input: 100,
          output: 99,
          cacheRead: 20,
          cacheWrite: 5,
          reasoning: 10,
          cost: { total: 0.25 },
        },
      },
    };
    const result = await scan([{ type: "session", id: "pi-session" }, entry], "pi");
    expect(result.records).toEqual([
      {
        provider: "pi",
        model: "anthropic/actual",
        rateModel: "actual",
        sessionId: "pi-session",
        timestampMs: Date.parse(timestamp),
        totals: {
          uncachedInputTokens: 100,
          outputTokens: 99,
          cachedInputTokens: 20,
          cacheCreationTokens: 5,
          reasoningTokens: 10,
        },
        reportedCostUsd: 0.25,
        speed: "standard",
        dedupeKey: JSON.stringify(["pi", entry.id, timestamp, "anthropic/actual"]),
      },
    ]);
  });
});
