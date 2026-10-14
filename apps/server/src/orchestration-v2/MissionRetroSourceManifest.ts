// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds sanitized source bytes to content addresses.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { OrchestratorMcpServiceShape } from "../mcp/OrchestratorMcpService.ts";
import type { ThreadId, TurnItemId } from "../../../../packages/contracts/src/baseSchemas.ts";
import type {
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadTimelineItem,
} from "../../../../packages/contracts/src/orchestratorMcp.ts";
import type { MissionRetroSourceRef as MissionRetroSourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";

/**
 * Bounded Retro source collector. Reads one explicit bounded window
 * `[fromInclusive, toExclusive)` from the root-authorized source threads
 * through the SUPPORTED `OrchestratorMcpService.readThread` API and returns
 * an immutable sanitized source artifact (bytes plus manifest index).
 *
 * No model is launched, no report is created, no triage runs, no skills are
 * read or written, and nothing is persisted here: the root (or its existing
 * artifact adapter) persists the returned bytes privately later. This module
 * performs no filesystem, SQL, git, network, or outbox work of any kind.
 *
 * Authority rules, all fail-closed:
 * - The trusted scope (canonical team/env/mission, preparation identity, source root,
 *   allowed source thread IDs, and range) is root-provided and revalidated;
 *   caller JSON, persona labels, and paths never authorize anything.
 * - `authorize` is an explicit root-supplied gate with no default success.
 *   It runs BEFORE the first source read and again BEFORE the bundle is
 *   returned. A missing gate (not a function) fails before any API call.
 * - `sanitize` is an explicit deterministic root-supplied gate for
 *   text/title/tool-input/tool-output/process-argument content. The read
 *   API folds tool and process content into item text, so every text/title
 *   value passes through it. A missing or failing sanitizer exports
 *   nothing. There is no built-in pattern redactor here: a fake redactor
 *   must never claim secret safety.
 * - Reads use the caller's actual MCP scope verbatim. Only threads in the
 *   explicit allowed list are ever read; child references seen in descriptors
 *   stay unknown and are never expanded automatically.
 * - Truncated texts are recovered fragment by fragment by
 *   `(itemId, textOffset, nextTextOffset)` until complete. Fragments are
 *   UTF-16 code units (JS string semantics, surrogate pairs preserved
 *   exactly); identity, position, offsets, and overlapping bytes are
 *   verified, and any cycle, hole, conflict, foreign source, or mid-read
 *   mutation fails closed instead of fabricating coverage.
 * - `apiCoverage` is `full` only when every position of every allowed
 *   thread's bounded window is read to complete sanitized text with no
 *   omissions and no uncovered ranges. Child-log and raw-stdout coverage
 *   always stay `unknown`: this collector never reads child logs or stdout,
 *   and `pendingChildRuns` reflects exact `recentRuns` API telemetry only.
 * - Exporting this manifest never claims a reporter read it: there are no
 *   read receipts here. Trusted read receipts remain a separate future
 *   endpoint, and nothing here certifies skill invocation.
 */

export class MissionRetroSourceManifestError extends Schema.TaggedError<MissionRetroSourceManifestError>()(
  "MissionRetroSourceManifestError",
  {
    operation: Schema.Literal("collect"),
    category: Schema.Literals([
      "scope_denied",
      "sanitizer_unavailable",
      "sanitizer_failed",
      "read_failed",
      "source_rejected",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Mission retro source collect failed (${this.category}).`;
  }
}

/** Root-provided trusted scope/boundary. Every field is required. */
export interface MissionRetroSourceTrustedScope {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  /** Preparation identity, independent of the eventual canonical checkpoint ID and fingerprint. */
  readonly captureBoundaryId: string;
  /** Authorized supported-thread source identity every chunk ref binds to. */
  readonly sourceRoot: string;
  /**
   * Primary source thread: the only thread whose window is read. It anchors
   * the checkpoint, snapshot fingerprint, and every source ref range.
   */
  readonly sourceThreadId: string;
  /**
   * Whitelist of permitted `item.sourceThreadId` values (for example the
   * primary plus a child that contributed inherited items). Listing a thread
   * here never authorizes reading that thread's own window.
   */
  readonly allowedSourceThreadIds: ReadonlyArray<string>;
  readonly fromInclusive: number;
  readonly toExclusive: number;
}

/** Immutable snapshot of the actual caller, captured before any I/O. */
export interface MissionRetroCapturedCaller {
  readonly environmentId: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread:
    | {
        readonly threadId: string;
        readonly providerSessionId: string;
        readonly providerInstanceId: string;
      }
    | undefined;
  readonly client:
    | {
        readonly sessionId: string;
        readonly label: string;
        readonly runtimeModeCeiling: string;
      }
    | undefined;
}

/** What the root authorization gate decides over: boundary plus actual caller. */
export interface MissionRetroSourceAuthorizationContext {
  readonly trustedScope: MissionRetroSourceTrustedScope;
  readonly caller: MissionRetroCapturedCaller;
}

/** Content kind routed to the root sanitizer. */
export type MissionRetroSourceSanitizeField =
  | "text"
  | "title"
  | "toolInput"
  | "toolOutput"
  | "processArguments";

export interface MissionRetroSourceSanitizeInput {
  readonly threadId: string;
  readonly itemId: string;
  readonly position: number;
  readonly field: MissionRetroSourceSanitizeField;
  readonly itemType: string;
  readonly value: string | null;
}

/**
 * Structured sanitizer verdict. `omitted.cause` carries the non-secret
 * range/type/cause only, never the withheld content.
 */
export type MissionRetroSourceSanitized =
  | { readonly kind: "kept"; readonly value: string | null }
  | { readonly kind: "omitted"; readonly cause: string };

/**
 * Explicit root authorization gate. No default success exists: a missing
 * gate fails closed before any source read.
 */
export type MissionRetroSourceAuthorizer = (
  context: MissionRetroSourceAuthorizationContext,
) => Effect.Effect<void, MissionRetroSourceManifestError>;

/**
 * Explicit deterministic root sanitizer gate. No default exists: a missing
 * or failing sanitizer exports nothing.
 */
export type MissionRetroSourceSanitizer = (
  input: MissionRetroSourceSanitizeInput,
) => Effect.Effect<MissionRetroSourceSanitized, MissionRetroSourceManifestError>;

/** Injected authentic read binding: the real `OrchestratorMcpService`. */
export type MissionRetroSourceReader = Pick<OrchestratorMcpServiceShape, "readThread">;

export interface MissionRetroSourceBudget {
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxChunks: number;
}

/** Bounded defaults. Exhaustion returns explicit partial, never silent truncation. */
export const DEFAULT_MISSION_RETRO_SOURCE_BUDGET: MissionRetroSourceBudget = {
  maxPages: 32,
  maxItems: 400,
  maxBytes: 1_048_576,
  maxChunks: 16,
};

/** Hard schema ceiling: at most 16 source refs per checkpoint descriptor. */
export const MAX_MISSION_RETRO_SOURCE_CHUNKS = 16;
export const MAX_MISSION_RETRO_SOURCE_THREADS = 16;
export const MAX_MISSION_RETRO_OMISSIONS = 16;
const MAX_ID_LENGTH = 256;
const MAX_WINDOW_POSITIONS = 10_000;
const MAX_PAGES_HARD = 64;
const MAX_ITEMS_HARD = 1_000;
const MAX_BYTES_HARD = 2_097_152;
const MAX_UNCOVERED_RANGES = 32;
const MAX_RECOVERED_TEXT_CHARS = 200_000;
/** Chunking is byte/count bounded, not a tiny fixed position count, so a
 * contiguous run of short items is not artificially split past 16 refs. */
const MAX_ITEMS_PER_CHUNK = 128;
const MAX_CHUNK_BYTES = 65_536;
/** Supported API ceilings (limit <= 100, runLimit <= 50, chars <= 50000). */
const PAGE_LIMIT = 100;
const ITEM_MAX_CHARS = 50_000;
const RUN_LIMIT = 50;
/** Terminal run statuses for exact `recentRuns` telemetry. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
const COVERAGE_POLICY = "explicit-activity-window-v1";

export interface MissionRetroSourceUncoveredRange {
  readonly fromInclusive: number;
  readonly toExclusive: number;
}

/** Exact bytes whose SHA-256 is `chunkHash`; verify without stripping fields. */
export interface MissionRetroChunkArtifact {
  readonly chunkRef: string;
  readonly chunkHash: string;
  readonly chunkBytes: string;
  readonly threadId: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
}

export interface MissionRetroSourceBundle {
  /** Immutable UTF-8 artifact bytes (canonical JSON). */
  readonly artifactBytes: string;
  /** Exact SHA-256 hex over the UTF-8 artifact bytes. */
  readonly artifactSha256: string;
  readonly artifactRef: string;
  /** Preimage whose SHA-256 is `snapshotFingerprint` (scope/range/identities/hashes/policy). */
  readonly snapshotPreimage: string;
  readonly snapshotFingerprint: string;
  /** Manifest index implementing `MissionRetroSourceRef` (<= 16 refs). */
  readonly sourceRefs: ReadonlyArray<MissionRetroSourceRefValue>;
  /** Exact per-chunk bytes matching `sourceRefs[].chunkHash`, deep-frozen. */
  readonly chunkArtifacts: ReadonlyArray<MissionRetroChunkArtifact>;
  readonly omissions: ReadonlyArray<string>;
  readonly uncoveredRanges: ReadonlyArray<MissionRetroSourceUncoveredRange>;
  readonly apiCoverage: "full" | "partial" | "unknown";
  readonly childLogCoverage: "unknown";
  readonly rawStdoutCoverage: "unknown";
  readonly pendingChildRuns: boolean;
  /** False when bounded run telemetry cannot prove the pending verdict. */
  readonly pendingChildRunsKnown: boolean;
  readonly threadsRead: ReadonlyArray<string>;
  readonly itemCount: number;
}

export interface MissionRetroSourceCollectInput {
  readonly trustedScope: MissionRetroSourceTrustedScope;
  readonly mcpScope: McpInvocationScope;
  readonly reader: MissionRetroSourceReader;
  readonly authorize: MissionRetroSourceAuthorizer;
  readonly sanitize: MissionRetroSourceSanitizer;
  readonly budget?: MissionRetroSourceBudget | undefined;
}

const isManifestError = Schema.is(MissionRetroSourceManifestError);

const safeDetail = (detail: string): string =>
  detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256);

/** Errors carry only fixed bounded detail: never a raw cause or caller text. */
const manifestError = (
  category: MissionRetroSourceManifestError["category"],
  detail: string,
): MissionRetroSourceManifestError =>
  new MissionRetroSourceManifestError({ operation: "collect", category, detail: safeDetail(detail) });

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

const sha256Hex = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const utf8Length = (text: string): number => Buffer.byteLength(text, "utf8");

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

interface NormalizedScope extends MissionRetroSourceTrustedScope {
  readonly primary: ThreadId;
  readonly allowed: ReadonlyArray<ThreadId>;
}

const normalizeScope = (scope: MissionRetroSourceTrustedScope): NormalizedScope | null => {
  if (scope === null || typeof scope !== "object") return null;
  if (
    !nonEmpty(scope.teamId) ||
    !nonEmpty(scope.environmentId) ||
    !nonEmpty(scope.missionId) ||
    !nonEmpty(scope.captureBoundaryId) ||
    !nonEmpty(scope.sourceRoot) ||
    !nonEmpty(scope.sourceThreadId)
  ) {
    return null;
  }
  if (!isInt(scope.fromInclusive) || !isInt(scope.toExclusive)) return null;
  if (scope.fromInclusive < 0 || !(scope.fromInclusive < scope.toExclusive)) return null;
  if (scope.toExclusive - scope.fromInclusive > MAX_WINDOW_POSITIONS) return null;
  if (!Array.isArray(scope.allowedSourceThreadIds) || scope.allowedSourceThreadIds.length === 0) {
    return null;
  }
  if (scope.allowedSourceThreadIds.length > MAX_MISSION_RETRO_SOURCE_THREADS) return null;
  if (scope.allowedSourceThreadIds.some((thread) => !nonEmpty(thread))) return null;
  const allowed = Object.freeze(
    [...new Set(scope.allowedSourceThreadIds)].sort().map((thread) => thread as ThreadId),
  );
  if (!allowed.includes(scope.sourceThreadId as ThreadId)) return null;
  return deepFreeze({
    teamId: scope.teamId,
    environmentId: scope.environmentId,
    missionId: scope.missionId,
    captureBoundaryId: scope.captureBoundaryId,
    sourceRoot: scope.sourceRoot,
    sourceThreadId: scope.sourceThreadId,
    allowedSourceThreadIds: allowed,
    fromInclusive: scope.fromInclusive,
    toExclusive: scope.toExclusive,
    primary: scope.sourceThreadId as ThreadId,
    allowed,
  });
};

const normalizeBudget = (budget: MissionRetroSourceBudget | undefined): MissionRetroSourceBudget | null => {
  const base = budget ?? DEFAULT_MISSION_RETRO_SOURCE_BUDGET;
  if (base === null || typeof base !== "object") return null;
  if (
    !isInt(base.maxPages) || base.maxPages <= 0 || base.maxPages > MAX_PAGES_HARD ||
    !isInt(base.maxItems) || base.maxItems <= 0 || base.maxItems > MAX_ITEMS_HARD ||
    !isInt(base.maxBytes) || base.maxBytes <= 0 || base.maxBytes > MAX_BYTES_HARD ||
    !isInt(base.maxChunks) || base.maxChunks <= 0 || base.maxChunks > MAX_MISSION_RETRO_SOURCE_CHUNKS
  ) {
    return null;
  }
  return Object.freeze({
    maxPages: base.maxPages,
    maxItems: base.maxItems,
    maxBytes: base.maxBytes,
    maxChunks: base.maxChunks,
  });
};

/** Snapshot the actual caller before any yield so later mutation cannot switch principal. */
const captureCaller = (scope: McpInvocationScope): MissionRetroCapturedCaller | null => {
  if (scope === null || typeof scope !== "object") return null;
  if (!nonEmpty(scope.environmentId as unknown) || typeof scope.requestNamespace !== "string" || scope.requestNamespace.length > 256) return null;
  if (typeof scope.issuedAt !== "number" || !Number.isFinite(scope.issuedAt)) return null;
  let capabilities: Array<string>;
  try {
    const raw: unknown = scope.capabilities;
    if (raw instanceof Set) capabilities = [...raw];
    else if (Array.isArray(raw)) capabilities = [...raw];
    else return null;
  } catch {
    return null;
  }
  if (capabilities.some((capability) => typeof capability !== "string" || capability.length > 64)) return null;
  const thread =
    scope.thread === undefined
      ? undefined
      : Object.freeze({
          threadId: String(scope.thread.threadId),
          providerSessionId: String(scope.thread.providerSessionId),
          providerInstanceId: String(scope.thread.providerInstanceId),
        });
  const client =
    scope.client === undefined
      ? undefined
      : Object.freeze({
          sessionId: String(scope.client.sessionId),
          label: String(scope.client.label),
          runtimeModeCeiling: String(scope.client.runtimeModeCeiling),
        });
  return deepFreeze({
    environmentId: scope.environmentId as unknown as string,
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    issuedAt: scope.issuedAt,
    requestNamespace: scope.requestNamespace,
    thread,
    client,
  });
};

const callerToMcpScope = (caller: MissionRetroCapturedCaller): McpInvocationScope =>
  Object.freeze({
    environmentId: caller.environmentId as McpInvocationScope["environmentId"],
    capabilities: new Set(caller.capabilities) as unknown as McpInvocationScope["capabilities"],
    issuedAt: caller.issuedAt,
    requestNamespace: caller.requestNamespace,
    thread: caller.thread as McpInvocationScope["thread"],
    client: caller.client as McpInvocationScope["client"],
  }) as McpInvocationScope;

interface SanitizedEntry {
  readonly threadId: string;
  readonly position: number;
  readonly itemId: string;
  readonly sourceThreadId: string;
  readonly runId: string | null;
  readonly messageId: string | null;
  readonly type: string;
  readonly status: string;
  readonly visibility: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly createdBy: string | null;
  readonly creationSource: string | null;
  readonly updatedAt: string;
}

interface ChunkPayload {
  readonly chunkRef: string;
  readonly chunkHash: string;
  readonly threadId: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
  readonly items: ReadonlyArray<SanitizedEntry>;
}

const OMISSION_CAUSE_LIMIT = 400;

const omissionFor = (position: number, type: string, cause: string): string => {
  const trimmed = cause.length > OMISSION_CAUSE_LIMIT ? `${cause.slice(0, OMISSION_CAUSE_LIMIT)}…` : cause;
  return `pos ${position} type ${type}: ${trimmed}`.slice(0, 512);
};

interface CollectorState {
  pagesUsed: number;
  itemsRecorded: number;
  bytesRecorded: number;
  partial: boolean;
  omissions: Array<string>;
  uncovered: Array<MissionRetroSourceUncoveredRange>;
  entries: Array<SanitizedEntry>;
  pendingChildRuns: boolean;
  pendingChildRunsKnown: boolean;
  threadsRead: Array<string>;
}

const mergeRanges = (
  ranges: ReadonlyArray<MissionRetroSourceUncoveredRange>,
): Array<MissionRetroSourceUncoveredRange> => {
  const sorted = [...ranges].sort((a, b) => a.fromInclusive - b.fromInclusive);
  const merged: Array<MissionRetroSourceUncoveredRange> = [];
  for (const range of sorted) {
    const tail = merged[merged.length - 1];
    if (tail !== undefined && range.fromInclusive <= tail.toExclusive) {
      if (range.toExclusive > tail.toExclusive) {
        merged[merged.length - 1] = { fromInclusive: tail.fromInclusive, toExclusive: range.toExclusive };
      }
    } else {
      merged.push({ ...range });
    }
  }
  if (merged.length <= MAX_UNCOVERED_RANGES) return merged;
  // Coalesce to a bounded index: widest gaps keep their exact ranges, the
  // remainder collapse into their spanning envelope (still never claimed read).
  const head = merged.slice(0, MAX_UNCOVERED_RANGES - 1);
  const rest = merged.slice(MAX_UNCOVERED_RANGES - 1);
  const first = rest[0];
  const last = rest[rest.length - 1];
  if (first !== undefined && last !== undefined) {
    head.push({ fromInclusive: first.fromInclusive, toExclusive: last.toExclusive });
  }
  return head;
};

const markUncovered = (state: CollectorState, from: number, to: number): void => {
  if (from < to) {
    state.uncovered.push({ fromInclusive: from, toExclusive: to });
    state.uncovered = mergeRanges(state.uncovered);
  }
  state.partial = true;
};

const OMISSION_SENTINEL = "further omission notes withheld: omission bound exceeded";

const markOmission = (state: CollectorState, note: string): void => {
  if (state.omissions.length < MAX_MISSION_RETRO_OMISSIONS - 1) {
    state.omissions.push(note.slice(0, 512));
  } else if (
    state.omissions.length === MAX_MISSION_RETRO_OMISSIONS - 1 &&
    !state.omissions.includes(OMISSION_SENTINEL)
  ) {
    state.omissions.push(OMISSION_SENTINEL);
  }
  state.partial = true;
};

interface ReadDeps {
  readonly mcpScope: McpInvocationScope;
  readonly reader: MissionRetroSourceReader;
  readonly sanitize: MissionRetroSourceSanitizer;
  readonly budget: MissionRetroSourceBudget;
  readonly itemMaxChars: number;
  readonly allowed: ReadonlySet<ThreadId>;
  readonly state: CollectorState;
}

type PageOutcome =
  | { readonly exhausted: true }
  | { readonly exhausted: false; readonly result: OrchestratorMcpThreadReadResult };

/** Materialize a returned DTO immediately, before any further yield. */
const cloneReadResult = (
  result: OrchestratorMcpThreadReadResult,
): OrchestratorMcpThreadReadResult | null => {
  try {
    if (result === null || typeof result !== "object") return null;
    if (!Array.isArray(result.items) || !Array.isArray(result.recentRuns)) return null;
    if (result.items.length > PAGE_LIMIT || result.recentRuns.length > RUN_LIMIT) return null;
    const items = result.items.map((item) => ({
      position: item.position,
      visibility: item.visibility,
      sourceThreadId: item.sourceThreadId,
      itemId: item.itemId,
      runId: item.runId,
      messageId: item.messageId,
      createdBy: item.createdBy,
      creationSource: item.creationSource,
      type: item.type,
      status: item.status,
      title: item.title,
      text: item.text,
      textTruncated: item.textTruncated,
      nextTextOffset: item.nextTextOffset,
      updatedAt: item.updatedAt,
    }));
    const recentRuns = result.recentRuns.map((run) => ({ ...run }));
    return {
      thread: { ...result.thread },
      recentRuns,
      items,
      nextPosition: result.nextPosition,
      hasMore: result.hasMore,
    };
  } catch {
    return null;
  }
};

/** Bounded page gate: at the bound, report exhaustion instead of reading. */
const tryReadPage = (
  deps: ReadDeps,
  input: OrchestratorMcpThreadReadInput,
): Effect.Effect<PageOutcome, MissionRetroSourceManifestError> => {
  if (deps.state.pagesUsed >= deps.budget.maxPages) {
    return Effect.succeed({ exhausted: true as const });
  }
  const frozenInput = Object.freeze({ ...input });
  return Effect.flatMap(
    Effect.mapError(deps.reader.readThread(deps.mcpScope, frozenInput), (cause: unknown) =>
      isManifestError(cause)
        ? new MissionRetroSourceManifestError({
            operation: "collect",
            category: cause.category,
            detail: "The source read failed.",
          })
        : manifestError("read_failed", "The source read failed."),
    ),
    (result) => {
      deps.state.pagesUsed += 1;
      const cloned = cloneReadResult(result);
      if (cloned === null) {
        return Effect.fail(manifestError("source_rejected", "The source read returned a malformed page."));
      }
      return Effect.succeed({ exhausted: false as const, result: cloned });
    },
  );
};

const sanitizeField = (
  deps: ReadDeps,
  input: MissionRetroSourceSanitizeInput,
): Effect.Effect<MissionRetroSourceSanitized, MissionRetroSourceManifestError> =>
  Effect.mapError(deps.sanitize(Object.freeze({ ...input })), (cause) =>
    isManifestError(cause) &&
    (cause.category === "sanitizer_failed" || cause.category === "sanitizer_unavailable")
      ? new MissionRetroSourceManifestError({
          operation: "collect",
          category: cause.category,
          detail: "The trusted sanitizer rejected the content.",
        })
      : manifestError("sanitizer_failed", "The trusted sanitizer rejected the content."),
  );

interface ItemIdentity {
  readonly itemId: TurnItemId;
  readonly position: number;
  readonly sourceThreadId: string;
  readonly runId: string | null;
  readonly messageId: string | null;
  readonly type: string;
  readonly status: string;
  readonly visibility: string;
  readonly title: string | null;
  readonly createdBy: string | null;
  readonly creationSource: string | null;
  readonly updatedAt: string;
}

const identityOf = (item: OrchestratorMcpThreadTimelineItem): ItemIdentity => ({
  itemId: item.itemId,
  position: item.position,
  sourceThreadId: item.sourceThreadId,
  runId: item.runId,
  messageId: item.messageId,
  type: item.type,
  status: item.status,
  visibility: item.visibility,
  title: item.title,
  createdBy: item.createdBy,
  creationSource: item.creationSource,
  updatedAt: item.updatedAt,
});

const sameIdentity = (left: ItemIdentity, right: ItemIdentity): boolean =>
  left.itemId === right.itemId &&
  left.position === right.position &&
  left.sourceThreadId === right.sourceThreadId &&
  left.runId === right.runId &&
  left.messageId === right.messageId &&
  left.type === right.type &&
  left.status === right.status &&
  left.visibility === right.visibility &&
  left.title === right.title &&
  left.createdBy === right.createdBy &&
  left.creationSource === right.creationSource &&
  left.updatedAt === right.updatedAt;

/**
 * Recover one item's complete text fragment by fragment. Fails closed on
 * cycles, holes, conflicting overlaps, identity drift, or inconsistent
 * truncation metadata. Reports incomplete when the page budget stops
 * recovery: the caller records the explicit partial.
 */
const recoverText = (
  deps: ReadDeps,
  threadId: ThreadId,
  seen: ItemIdentity,
  first: OrchestratorMcpThreadTimelineItem,
): Effect.Effect<
  { readonly complete: true; readonly text: string } | { readonly complete: false },
  MissionRetroSourceManifestError
> =>
  Effect.gen(function* () {
    if (first.text === null) {
      if (first.textTruncated) {
        return yield* manifestError("source_rejected", `Item '${seen.itemId}' reports truncation with no text.`);
      }
      return { complete: true as const, text: "" };
    }
    let assembled: string = first.text;
    let nextOffset: number | null = first.nextTextOffset ?? null;
    if (!first.textTruncated) return { complete: true as const, text: assembled };
    if (nextOffset === null || !isInt(nextOffset) || nextOffset <= 0) {
      return yield* manifestError(
        "source_rejected",
        `Item '${seen.itemId}' reports truncation with an unusable next offset.`,
      );
    }
    const visited = new Set<number>([0]);
    for (;;) {
      const offset: number | null = nextOffset;
      if (offset === null) {
        return yield* manifestError(
          "source_rejected",
          `Text recovery for item '${seen.itemId}' lost its offset.`,
        );
      }
      if (visited.has(offset)) {
        return yield* manifestError("source_rejected", `Text recovery cycled at offset ${offset}.`);
      }
      visited.add(offset);
      if (offset > assembled.length) {
        return yield* manifestError("source_rejected", `Text recovery left a hole at offset ${offset}.`);
      }
      const outcome: PageOutcome = yield* tryReadPage(deps, {
        threadId,
        itemId: seen.itemId,
        textOffset: offset,
        view: "activity",
        limit: PAGE_LIMIT,
        maxCharsPerItem: deps.itemMaxChars,
      });
      if (outcome.exhausted) return { complete: false as const };
      if (outcome.result.thread.threadId !== threadId) {
        return yield* manifestError("source_rejected", "The text recovery response has a different target thread.");
      }
      const match: OrchestratorMcpThreadTimelineItem | undefined = outcome.result.items.find(
        (candidate: OrchestratorMcpThreadTimelineItem) => candidate.itemId === seen.itemId,
      );
      if (match === undefined) {
        return yield* manifestError(
          "source_rejected",
          `Recovery for item '${seen.itemId}' returned no matching item.`,
        );
      }
      if (!sameIdentity(identityOf(match), seen)) {
        return yield* manifestError(
          "source_rejected",
          `Item '${seen.itemId}' changed mid-read; refusing to fabricate coverage.`,
        );
      }
      if (!deps.allowed.has(match.sourceThreadId)) {
        return yield* manifestError(
          "source_rejected",
          `Item '${seen.itemId}' arrived from an unauthorized source thread.`,
        );
      }
      const fragment: string | null = match.text;
      if (fragment === null) {
        return yield* manifestError(
          "source_rejected",
          `Recovery for item '${seen.itemId}' returned no text at offset ${offset}.`,
        );
      }
      if (fragment.length > deps.itemMaxChars) {
        return yield* manifestError(
          "source_rejected",
          `Recovery fragment for item '${seen.itemId}' exceeds the per-item bound.`,
        );
      }
      const overlapEnd = Math.min(assembled.length, offset + fragment.length);
      if (assembled.slice(offset, overlapEnd) !== fragment.slice(0, overlapEnd - offset)) {
        return yield* manifestError(
          "source_rejected",
          `Recovery fragments for item '${seen.itemId}' carry conflicting bytes.`,
        );
      }
      assembled = assembled.slice(0, offset) + fragment;
      if (assembled.length > MAX_RECOVERED_TEXT_CHARS) {
        return yield* manifestError("source_rejected", "Recovered text exceeds the bounded recovery limit.");
      }
      if (!match.textTruncated) {
        if (match.nextTextOffset !== undefined && match.nextTextOffset !== null) {
          return yield* manifestError(
            "source_rejected",
            `Item '${seen.itemId}' completed with inconsistent truncation metadata.`,
          );
        }
        return { complete: true as const, text: assembled };
      }
      const upcoming: number | null = match.nextTextOffset ?? null;
      if (upcoming === null || !isInt(upcoming) || upcoming <= offset || upcoming > offset + fragment.length) {
        return yield* manifestError(
          "source_rejected",
          `Item '${seen.itemId}' reports truncation with an unusable next offset.`,
        );
      }
      nextOffset = upcoming;
    }
  });

const collectThreadWindow = (
  deps: ReadDeps,
  scope: NormalizedScope,
  threadId: ThreadId,
): Effect.Effect<void, MissionRetroSourceManifestError> =>
  Effect.gen(function* () {
    let cursor: number = scope.fromInclusive;
    let firstItemCount: number | null = null;
    for (;;) {
      const base: OrchestratorMcpThreadReadInput = {
        threadId,
        view: "activity",
        limit: PAGE_LIMIT,
        runLimit: RUN_LIMIT,
        maxCharsPerItem: deps.itemMaxChars,
      };
      const input: OrchestratorMcpThreadReadInput =
        cursor === 0 ? base : { ...base, afterPosition: (cursor - 1) as never };
      const outcome: PageOutcome = yield* tryReadPage(deps, input);
      if (outcome.exhausted) {
        markOmission(deps.state, "budget exhausted: page bound reached while reading the primary thread");
        markUncovered(deps.state, cursor, scope.toExclusive);
        return;
      }
      const result: OrchestratorMcpThreadReadResult = outcome.result;
      if (result.thread.threadId !== threadId) {
        return yield* manifestError("source_rejected", "The API returned a different thread than requested.");
      }
      if (!isInt(result.thread.itemCount) || !isInt(result.thread.runCount) || !isInt(result.thread.pendingRequestCount)) {
        return yield* manifestError("source_rejected", "The API returned malformed thread telemetry.");
      }
      if (result.nextPosition !== null && !isInt(result.nextPosition)) {
        return yield* manifestError("source_rejected", "The API returned a malformed next cursor.");
      }
      if (firstItemCount === null) {
        firstItemCount = result.thread.itemCount;
        deps.state.threadsRead.push(threadId);
        const runs = result.recentRuns;
        const hasNonTerminal = runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status));
        const historyTruncated = result.thread.runCount > runs.length || runs.length >= RUN_LIMIT;
        if (
          result.thread.pendingRequestCount > 0 ||
          result.thread.activeRunId !== null ||
          hasNonTerminal ||
          historyTruncated
        ) {
          deps.state.pendingChildRuns = true;
        }
        if (historyTruncated) deps.state.pendingChildRunsKnown = false;
        if (result.thread.pendingRequestCount > 0 || result.thread.activeRunId !== null || hasNonTerminal) {
          deps.state.pendingChildRunsKnown = true;
        }
      } else if (result.thread.itemCount < firstItemCount) {
        return yield* manifestError("source_rejected", "The primary thread shrank mid-read; refusing an unstable boundary.");
      }
      if (result.items.length === 0) {
        if (result.hasMore) {
          return yield* manifestError("source_rejected", "The API returned an empty page with more data pending.");
        }
        if (cursor < scope.toExclusive) {
          markOmission(deps.state, "window tail unread: positions absent from the published timeline");
          markUncovered(deps.state, cursor, scope.toExclusive);
        }
        return;
      }
      let advanced = false;
      for (const item of result.items) {
        if (!isInt(item.position) || item.position < 0) {
          return yield* manifestError("source_rejected", "The API returned a non-integer item position.");
        }
        if (item.position >= scope.toExclusive) {
          // Appended items outside the window are ignored, but an unread
          // tail inside the window is never certified as read.
          if (cursor < scope.toExclusive) {
            markOmission(deps.state, "window tail unread: first returned item lies beyond the bounded window");
            markUncovered(deps.state, cursor, scope.toExclusive);
          }
          return;
        }
        if (item.position < cursor) {
          return yield* manifestError("source_rejected", "The API returned a duplicate position.");
        }
        if (item.position > cursor) {
          markOmission(deps.state, "position gap in the published timeline; gap was not read");
          markUncovered(deps.state, cursor, item.position);
          cursor = item.position;
        }
        if (!deps.allowed.has(item.sourceThreadId)) {
          return yield* manifestError("source_rejected", "An item arrived from an unauthorized source thread.");
        }
        if (deps.state.itemsRecorded >= deps.budget.maxItems) {
          markOmission(deps.state, "budget exhausted: item bound reached on the primary thread");
          markUncovered(deps.state, cursor, scope.toExclusive);
          return;
        }
        const seen: ItemIdentity = identityOf(item);
        const recovered = yield* recoverText(deps, threadId, seen, item);
        if (!recovered.complete) {
          markOmission(deps.state, "budget exhausted: text recovery stopped on the primary thread");
          markUncovered(deps.state, cursor, scope.toExclusive);
          return;
        }
        const sanitizedText = yield* sanitizeField(deps, {
          threadId,
          itemId: seen.itemId,
          position: seen.position,
          field: "text",
          itemType: seen.type,
          value: item.text === null ? null : recovered.text,
        });
        const sanitizedTitle = yield* sanitizeField(deps, {
          threadId,
          itemId: seen.itemId,
          position: seen.position,
          field: "title",
          itemType: seen.type,
          value: item.title,
        });
        if (sanitizedText.kind === "omitted") {
          markOmission(deps.state, omissionFor(seen.position, seen.type, sanitizedText.cause));
          markUncovered(deps.state, seen.position, seen.position + 1);
          cursor = seen.position + 1;
          advanced = true;
          continue;
        }
        const titleText: string | null = sanitizedTitle.kind === "omitted" ? null : sanitizedTitle.value;
        if (sanitizedTitle.kind === "omitted") {
          markOmission(deps.state, omissionFor(seen.position, `${seen.type}/title`, sanitizedTitle.cause));
        }
        const entry: SanitizedEntry = {
          threadId,
          position: seen.position,
          itemId: seen.itemId,
          sourceThreadId: seen.sourceThreadId,
          runId: seen.runId,
          messageId: seen.messageId,
          type: seen.type,
          status: seen.status,
          visibility: seen.visibility,
          title: titleText,
          text: sanitizedText.value,
          createdBy: seen.createdBy,
          creationSource: seen.creationSource,
          updatedAt: seen.updatedAt,
        };
        const entryBytes = utf8Length(stableStringify(entry));
        if (deps.state.bytesRecorded + entryBytes > deps.budget.maxBytes) {
          markOmission(deps.state, "budget exhausted: byte bound reached on the primary thread");
          markUncovered(deps.state, cursor, scope.toExclusive);
          return;
        }
        deps.state.bytesRecorded += entryBytes;
        deps.state.itemsRecorded += 1;
        deps.state.entries.push(entry);
        cursor = seen.position + 1;
        advanced = true;
        if (cursor >= scope.toExclusive) return;
      }
      if (!advanced) {
        return yield* manifestError("source_rejected", "The primary thread made no progress.");
      }
      // The API cursor must agree exactly with the verified sequence; a
      // null or jumping cursor cannot forge coverage. Next reads are always
      // derived from the verified cursor, never from nextPosition.
      if (result.nextPosition !== null && result.nextPosition !== cursor - 1) {
        return yield* manifestError("source_rejected", "The API cursor does not match the verified position sequence.");
      }
      if (!result.hasMore) {
        if (cursor < scope.toExclusive) {
          markOmission(deps.state, "window tail unread: positions absent from the published timeline");
          markUncovered(deps.state, cursor, scope.toExclusive);
        }
        return;
      }
      if (result.nextPosition === null) {
        return yield* manifestError("source_rejected", "The API reported more data without a usable cursor.");
      }
    }
  });

const chunkEntries = (entries: ReadonlyArray<SanitizedEntry>): ReadonlyArray<ReadonlyArray<SanitizedEntry>> => {
  const runs: Array<Array<SanitizedEntry>> = [];
  const runBytes: Array<number> = [];
  for (const entry of entries) {
    const entryBytes = utf8Length(stableStringify(entry));
    const current: Array<SanitizedEntry> | undefined = runs[runs.length - 1];
    const tail: SanitizedEntry | undefined = current?.[current.length - 1];
    const currentBytes = runBytes[runBytes.length - 1] ?? 0;
    if (
      current !== undefined &&
      tail !== undefined &&
      current.length < MAX_ITEMS_PER_CHUNK &&
      currentBytes + entryBytes <= MAX_CHUNK_BYTES &&
      tail.threadId === entry.threadId &&
      tail.position + 1 === entry.position
    ) {
      current.push(entry);
      runBytes[runBytes.length - 1] = currentBytes + entryBytes;
    } else {
      runs.push([entry]);
      runBytes.push(entryBytes);
    }
  }
  return runs;
};

/**
 * Collect the bounded Retro source bundle. Pure orchestration over the
 * injected read binding: no persistence, no model, no skills, no I/O here.
 */
export const collectRetroSources: (
  input: MissionRetroSourceCollectInput,
) => Effect.Effect<MissionRetroSourceBundle, MissionRetroSourceManifestError> = Effect.fn(
  "MissionRetroSourceManifest.collect",
)(function* (input: MissionRetroSourceCollectInput) {
  // Snapshot every boundary, budget, port, and caller fact before any yield.
  const authorizeFn = input?.authorize;
  const sanitizeFn = input?.sanitize;
  const readerFn = input?.reader?.readThread;
  const scope = normalizeScope(input?.trustedScope);
  if (scope === null) {
    return yield* manifestError("scope_denied", "The trusted scope is missing its boundary.");
  }
  const budget = normalizeBudget(input?.budget);
  if (budget === null) {
    return yield* manifestError("scope_denied", "The collect budget is not a bounded positive budget.");
  }
  if (typeof authorizeFn !== "function") {
    return yield* manifestError("scope_denied", "A required trusted gate is missing; refusing to read or export.");
  }
  if (typeof sanitizeFn !== "function") {
    return yield* manifestError("sanitizer_unavailable", "A required trusted gate is missing; refusing to read or export.");
  }
  if (typeof readerFn !== "function" || input.mcpScope === undefined || input.mcpScope === null) {
    return yield* manifestError("scope_denied", "The injected read binding or caller scope is missing.");
  }
  const caller = captureCaller(input.mcpScope);
  if (caller === null) {
    return yield* manifestError("scope_denied", "The actual caller scope could not be captured.");
  }
  if (caller.environmentId !== scope.environmentId) {
    return yield* manifestError("scope_denied", "The actual caller environment does not match the trusted boundary.");
  }
  if (!caller.capabilities.includes("orchestration")) {
    return yield* manifestError("scope_denied", "The actual caller lacks the required read capability.");
  }
  const capturedReader: MissionRetroSourceReader = Object.freeze({
    readThread: readerFn.bind(input.reader),
  });
  const authContext: MissionRetroSourceAuthorizationContext = deepFreeze({
    trustedScope: scope,
    caller,
  });
  const authorize = (detail: string): Effect.Effect<void, MissionRetroSourceManifestError> =>
    Effect.mapError(authorizeFn(authContext), (cause) =>
      isManifestError(cause)
        ? new MissionRetroSourceManifestError({
            operation: "collect",
            category: cause.category,
            detail,
          })
        : manifestError("scope_denied", detail),
    );
  // Gate one: before the first source read, over captured caller + boundary.
  yield* authorize("The trusted scope gate denied this source window.");
  const state: CollectorState = {
    pagesUsed: 0,
    itemsRecorded: 0,
    bytesRecorded: 0,
    partial: false,
    omissions: [],
    uncovered: [],
    entries: [],
    pendingChildRuns: false,
    pendingChildRunsKnown: true,
    threadsRead: [],
  };
  const deps: ReadDeps = Object.freeze({
    mcpScope: callerToMcpScope(caller),
    reader: capturedReader,
    sanitize: sanitizeFn,
    budget,
    itemMaxChars: ITEM_MAX_CHARS,
    allowed: new Set(scope.allowed),
    state,
  });
  // Only the primary thread's window is ever read. The whitelist only
  // permits inherited items; it never expands into child reads.
  yield* collectThreadWindow(deps, scope, scope.primary);
  const ordered = [...state.entries].sort((a, b) => a.position - b.position);
  let runs = chunkEntries(ordered);
  if (runs.length > budget.maxChunks) {
    const dropped = runs.slice(budget.maxChunks);
    runs = runs.slice(0, budget.maxChunks);
    markOmission(state, "chunk bound exceeded: trailing chunks withheld and excluded from coverage");
    for (const run of dropped) {
      const first = run[0];
      const last = run[run.length - 1];
      if (first !== undefined && last !== undefined) markUncovered(state, first.position, last.position + 1);
    }
  }
  const buildBundle = (
    keptRuns: ReadonlyArray<ReadonlyArray<SanitizedEntry>>,
  ): { readonly bundle: MissionRetroSourceBundle; readonly bytes: number } => {
    const chunks: Array<ChunkPayload & { readonly chunkBytes: string }> = keptRuns.map((run) => {
      const first: SanitizedEntry | undefined = run[0];
      const last: SanitizedEntry | undefined = run[run.length - 1];
      if (first === undefined || last === undefined) throw new Error("unreachable empty chunk run");
      const payload = {
        threadId: first.threadId,
        coveredFromInclusive: first.position,
        coveredToExclusive: last.position + 1,
        items: run,
      };
      const chunkBytes = stableStringify(payload);
      const hash = sha256Hex(chunkBytes);
      const ref = `retro-source-chunk:${hash}`;
      return { chunkRef: ref, chunkHash: hash, chunkBytes, ...payload };
    });
    const uncovered = mergeRanges(state.uncovered);
    const apiCoverage: MissionRetroSourceBundle["apiCoverage"] =
      state.partial || uncovered.length > 0 || state.omissions.length > 0 ? "partial" : "full";
    const artifactBody = {
      version: 1,
      coveragePolicy: COVERAGE_POLICY,
      scope: {
        teamId: scope.teamId,
        environmentId: scope.environmentId,
        missionId: scope.missionId,
        captureBoundaryId: scope.captureBoundaryId,
        sourceRoot: scope.sourceRoot,
        sourceThreadId: scope.sourceThreadId,
        fromInclusive: scope.fromInclusive,
        toExclusive: scope.toExclusive,
      },
      threadsRead: [...state.threadsRead].sort(),
      chunks: chunks.map(({ chunkBytes: _bytes, ...chunk }) => chunk),
      omissions: [...state.omissions],
      uncoveredRanges: uncovered,
      coverage: {
        apiCoverage,
        childLogCoverage: "unknown" as const,
        rawStdoutCoverage: "unknown" as const,
        pendingChildRuns: state.pendingChildRuns,
        pendingChildRunsKnown: state.pendingChildRunsKnown,
      },
    };
    const artifactBytes = stableStringify(artifactBody);
    const artifactSha256 = sha256Hex(artifactBytes);
    const snapshotPreimage = stableStringify({
      version: 1,
      coveragePolicy: COVERAGE_POLICY,
      teamId: scope.teamId,
      environmentId: scope.environmentId,
      missionId: scope.missionId,
      captureBoundaryId: scope.captureBoundaryId,
      sourceRoot: scope.sourceRoot,
      sourceThreadId: scope.sourceThreadId,
      fromInclusive: scope.fromInclusive,
      toExclusive: scope.toExclusive,
      threadsRead: [...state.threadsRead].sort(),
      chunkHashes: chunks.map((chunk) => chunk.chunkHash),
      artifactSha256,
    });
    const keptCount = keptRuns.reduce((count, run) => count + run.length, 0);
    const bundle: MissionRetroSourceBundle = deepFreeze({
      artifactBytes,
      artifactSha256,
      artifactRef: `retro-source:${artifactSha256}`,
      snapshotPreimage,
      snapshotFingerprint: sha256Hex(snapshotPreimage),
      sourceRefs: chunks.map((chunk) => ({
        rootRef: scope.sourceRoot,
        chunkRef: chunk.chunkRef,
        chunkHash: chunk.chunkHash,
        coveredFromInclusive: chunk.coveredFromInclusive,
        coveredToExclusive: chunk.coveredToExclusive,
      })),
      chunkArtifacts: chunks.map((chunk) => ({
        chunkRef: chunk.chunkRef,
        chunkHash: chunk.chunkHash,
        chunkBytes: chunk.chunkBytes,
        threadId: chunk.threadId,
        coveredFromInclusive: chunk.coveredFromInclusive,
        coveredToExclusive: chunk.coveredToExclusive,
      })),
      omissions: [...state.omissions],
      uncoveredRanges: uncovered,
      apiCoverage,
      childLogCoverage: "unknown" as const,
      rawStdoutCoverage: "unknown" as const,
      pendingChildRuns: state.pendingChildRuns,
      pendingChildRunsKnown: state.pendingChildRunsKnown,
      threadsRead: [...state.threadsRead].sort(),
      itemCount: keptCount,
    });
    return { bundle, bytes: utf8Length(artifactBytes) };
  };
  // The byte budget caps the final export artifact, metadata included.
  let built = buildBundle(runs);
  while (built.bytes > budget.maxBytes && runs.length > 0) {
    const droppedRun = runs[runs.length - 1];
    runs = runs.slice(0, -1);
    markOmission(state, "byte bound exceeded: trailing chunk withheld from the final artifact");
    const first = droppedRun?.[0];
    const last = droppedRun?.[droppedRun.length - 1];
    if (first !== undefined && last !== undefined) markUncovered(state, first.position, last.position + 1);
    built = buildBundle(runs);
  }
  if (built.bytes > budget.maxBytes) {
    return yield* manifestError("scope_denied", "The byte budget is too small for a bounded source artifact.");
  }
  if (built.bundle.sourceRefs.length > MAX_MISSION_RETRO_SOURCE_CHUNKS) {
    return yield* manifestError("source_rejected", "Chunking exceeded the per-checkpoint source ref bound.");
  }
  // Revalidate the captured caller and boundary before export.
  if (caller.environmentId !== scope.environmentId || !caller.capabilities.includes("orchestration")) {
    return yield* manifestError("scope_denied", "The captured caller no longer matches the trusted boundary.");
  }
  // Gate two: before returning the bundle, same captured principal.
  yield* authorize("The trusted scope gate denied this source bundle before export.");
  return built.bundle;
});
