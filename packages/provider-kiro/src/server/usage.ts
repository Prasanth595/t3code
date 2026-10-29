import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  EMPTY_TOTALS,
  parseTimestampMs,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { KiroSettings } from "../settings.ts";

const KiroScanState = Schema.Struct({
  sessionId: Schema.String,
  model: Schema.mutableKey(Schema.String),
});
type KiroScanState = typeof KiroScanState.Type;

// Kiro writes no token counts. A model switch appends a new session-context note,
// while session.json keeps only the latest model, so the note is the per-turn source.
const MODEL_NOTE = /The current model is ([^\n<]+?)\.?\s*(?:\n|<|$)/;
const UNKNOWN_MODEL = "kiro-unknown";

function modelSlug(display: string): string {
  return display.trim().toLowerCase().replace(/\s+/g, "-");
}

function creditsOf(summaries: unknown): number | null {
  if (!Array.isArray(summaries)) return null;
  let credits = 0;
  let found = false;
  for (const summary of summaries) {
    if (typeof summary !== "object" || summary === null) continue;
    const { unit, usage } = summary as { unit?: unknown; usage?: unknown };
    if (unit !== "credit" || typeof usage !== "number" || !Number.isFinite(usage)) continue;
    credits += Math.max(0, usage);
    found = true;
  }
  return found ? credits : null;
}

function parseRecord(parsed: unknown, state: KiroScanState): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const { timestamp, payload } = parsed as { timestamp?: unknown; payload?: unknown };
  if (typeof payload !== "object" || payload === null) return [];
  const entry = payload as {
    type?: unknown;
    content?: unknown;
    promptTurnSummaries?: unknown;
    executionId?: unknown;
  };
  if (entry.type === "agent_note") {
    const match = typeof entry.content === "string" ? MODEL_NOTE.exec(entry.content) : null;
    if (match?.[1]) state.model = modelSlug(match[1]);
    return [];
  }
  if (entry.type !== "usage_summary") return [];
  const timestampMs = parseTimestampMs(timestamp);
  const credits = creditsOf(entry.promptTurnSummaries);
  if (timestampMs === null || credits === null) return [];
  return [
    {
      provider: "kiro",
      timestampMs,
      model: state.model || UNKNOWN_MODEL,
      sessionId: state.sessionId,
      totals: EMPTY_TOTALS,
      reportedCostUsd: null,
      credits,
      speed: "standard",
      dedupeKey:
        typeof entry.executionId === "string" && entry.executionId.length > 0
          ? `kiro:${entry.executionId}`
          : null,
    },
  ];
}

// History lives at <sessions>/<workspace hash>/<session id>/messages.jsonl.
function sessionIdOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.at(-2) ?? "";
}

export const kiroUsageFormat: TranscriptUsageFormat<KiroScanState> = {
  selectFields: {
    timestamp: true,
    payload: { type: true, content: true, promptTurnSummaries: true, executionId: true },
  },
  usageMarkers: ['"usage_summary"', '"agent_note"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: {
    initial: (filePath) => ({ sessionId: sessionIdOf(filePath), model: "" }),
    schema: KiroScanState,
  },
  // Forked sessions copy their parent's turns, execution ids included.
  sharedSessionsAcrossFiles: true,
};

export const kiroUsageReader: ProviderUsageReader<KiroSettings, Path.Path> = {
  kind: "transcripts",
  provider: "kiro",
  format: kiroUsageFormat,
  directories: Effect.fn("kiroUsageReader.directories")(function* () {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    return [{ dir: path.join(home, ".kiro", "sessions"), fileName: "messages.jsonl" }];
  }),
};
