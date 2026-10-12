// @effect-diagnostics nodeBuiltinImport:off - exercise the transcript reader's
// real append/resume and projected-JSON paths with isolated fixture files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { codexUsageFormat } from "../provider/Drivers/codexUsage.ts";
import { decodeScanCache, encodeScanCache, type ScanCache } from "./usageScanCache.ts";
import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";

let dir: string;
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-effort-"));
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});
const jsonLine = (value: unknown) => JSON.stringify(value) + "\n";
const context = (effort?: string) =>
  jsonLine({
    type: "turn_context",
    payload: { model: "gpt-5.6-sol", ...(effort === undefined ? {} : { effort }) },
  });
const usage = (output: number) =>
  jsonLine({
    type: "event_msg",
    timestamp: "2026-10-01T12:00:00Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          output_tokens: output,
          reasoning_output_tokens: output / 2,
        },
      },
    },
  });

describe("recorded effort history", () => {
  it("keeps effort across a disk cache and append boundary, then clears an unknown turn", async () => {
    const path = NodePath.join(dir, "codex.jsonl");
    const prefix = context("low") + usage(10) + context("xhigh");
    await NodeFSP.writeFile(path, prefix);
    const first = (await readTranscriptRecords(path, codexUsageFormat))!;
    const cache: ScanCache = new Map([
      [
        path,
        {
          size: Buffer.byteLength(prefix),
          mtimeMs: 1,
          provider: "codex",
          records: first.records,
          tailRecords: first.tailRecords,
          position: first.position,
        },
      ],
    ]);
    const restored = decodeScanCache(
      JSON.parse(JSON.stringify(encodeScanCache(cache))),
      TEST_FORMAT_MAP,
    );
    await NodeFSP.appendFile(path, usage(20) + context() + usage(30));
    const resumed = (await readTranscriptRecords(
      path,
      codexUsageFormat,
      restored.get(path)!.position,
    ))!;
    const full = (await readTranscriptRecords(path, codexUsageFormat))!;

    expect(resumed.resumed).toBe(true);
    expect([...first.records, ...resumed.records]).toEqual(full.records);
    expect(full.records.map((record) => record.reasoningEffort)).toEqual([
      "low",
      "xhigh",
      undefined,
    ]);
    expect(full.records.map((record) => record.totals.outputTokens)).toEqual([10, 20, 30]);
  });

  it("retains Codex turn metadata in the projected reader used for large context lines", async () => {
    const path = NodePath.join(dir, "codex-projected.jsonl");
    await NodeFSP.writeFile(path, context(" HIGH ") + usage(10) + context("ultra") + usage(20));
    const native = (await readTranscriptRecords(path, codexUsageFormat))!;
    const projected = (await readTranscriptRecords(path, codexUsageFormat, undefined, {
      streamingThresholdBytes: 0,
    }))!;
    expect(projected.records).toEqual(native.records);
    expect(projected.records.map((record) => record.reasoningEffort)).toEqual(["high", "ultra"]);
  });

  it("reads Claude per-response metadata without inheriting effort into later responses", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    const metadata = [
      { perTurnEffort: "low", effort: "high" },
      { effort: " XHIGH " },
      { reasoningEffort: "ultra" },
      {},
      { perTurnEffort: 42 },
      { messageEffort: "future_effort" },
    ];
    await NodeFSP.writeFile(
      path,
      metadata
        .map(({ messageEffort, ...fields }, index) =>
          jsonLine({
            type: "assistant",
            timestamp: "2026-10-01T12:00:00Z",
            sessionId: "claude-session",
            ...fields,
            message: {
              id: String(index),
              model: "claude-fable-5",
              reasoning_effort: messageEffort,
              usage: { input_tokens: 10, output_tokens: 20 },
            },
          }),
        )
        .join(""),
    );
    const native = (await readTranscriptRecords(path, claudeUsageFormat))!;
    const projected = (await readTranscriptRecords(path, claudeUsageFormat, undefined, {
      streamingThresholdBytes: 0,
    }))!;
    expect(projected.records).toEqual(native.records);
    expect(native.records.map((record) => record.reasoningEffort)).toEqual([
      "low",
      "xhigh",
      "ultra",
      undefined,
      undefined,
      "future_effort",
    ]);
    expect(native.records.reduce((sum, record) => sum + record.totals.outputTokens, 0)).toBe(120);
  });
});
