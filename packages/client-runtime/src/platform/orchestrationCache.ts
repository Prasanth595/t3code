import {
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 3 as const;
// Older caches may contain human turns that bypassed server history budgets.
export const ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION = 5 as const;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
  // The server build whose stream last verified `snapshot`; a cold start on that build resumes.
  verifiedServerVersion: Schema.optionalKey(Schema.String),
});

export function withVerifiedServerVersion<S extends OrchestrationV2ShellSnapshot>(stored: {
  readonly snapshot: S;
  readonly verifiedServerVersion?: string;
}): S & { readonly verifiedServerVersion?: string } {
  return stored.verifiedServerVersion === undefined
    ? stored.snapshot
    : { ...stored.snapshot, verifiedServerVersion: stored.verifiedServerVersion };
}

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
    ...fields,
    projection: OrchestrationV2ThreadProjectionJson,
  })),
});

export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
