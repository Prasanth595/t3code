import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { v2Now, v2ShellSnapshot, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
} from "./orchestrationCache.ts";
import { makeStoredShellSnapshotEncoder } from "./shellCacheEncoding.ts";

const encodeWithSchema = Schema.encodeEffect(
  Schema.fromJsonString(StoredOrchestrationShellSnapshot),
);

const stored = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  archivedThreads: ReadonlyArray<OrchestrationV2ThreadShell> = [],
) => ({
  schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
  environmentId: EnvironmentId.make("environment-1"),
  snapshot: { ...v2ShellSnapshot, threads, archivedThreads },
});

// Rows mix dates, omitted optional fields, and a branch the row codec trims.
const row = (index: number): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id: ThreadId.make(`thread-${index}`),
  title: `Thread ${index}`,
  branch: index % 2 === 0 ? "  main  " : null,
  latestUserMessageAt: DateTime.add(v2Now, { minutes: index }),
  ...(index % 3 === 0 ? { pinnedAt: v2Now, snoozedUntil: null } : {}),
});

// More rows than fit in one encoding chunk.
const manyRows = () => Array.from({ length: 70 }, (_, index) => row(index));

describe("makeStoredShellSnapshotEncoder", () => {
  it.effect("writes exactly what the schema codec writes, before and after rows change", () =>
    Effect.gen(function* () {
      const encode = makeStoredShellSnapshotEncoder();
      const threads = manyRows();
      const first = stored(threads, [row(100)]);
      expect(yield* encode(first)).toBe(yield* encodeWithSchema(first));

      const [renamed, archived, ...rest] = threads;
      const next = stored(
        [{ ...renamed!, title: "Renamed" }, ...rest, row(70)],
        [...first.snapshot.archivedThreads, { ...archived!, archivedAt: v2Now }],
      );
      expect(yield* encode(next)).toBe(yield* encodeWithSchema(next));
    }),
  );

  it.effect("reuses the encoding of a row it has already saved", () =>
    Effect.gen(function* () {
      const encode = makeStoredShellSnapshotEncoder();
      const kept = { ...row(0) };
      yield* encode(stored([kept]));

      // The encoder trusts rows to be immutable, so an in-place edit shows whether it re-encoded.
      kept.title = "Edited in place";
      expect(yield* encode(stored([kept]))).toBe(yield* encodeWithSchema(stored([row(0)])));
    }),
  );

  it.effect("yields to a host timer between chunks by default", () =>
    Effect.gen(function* () {
      const setTimer = vi.spyOn(globalThis, "setTimeout");
      try {
        yield* makeStoredShellSnapshotEncoder()(stored(manyRows()));
        expect(setTimer).toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    }),
  );
});
