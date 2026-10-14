// @effect-diagnostics nodeBuiltinImport:off -- tests recompute expected content hashes.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "../../../../packages/contracts/src/baseSchemas.ts";
import type {
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadRun,
  OrchestratorMcpThreadTimelineItem,
} from "../../../../packages/contracts/src/orchestratorMcp.ts";
import type { ProviderInstanceId } from "../../../../packages/contracts/src/providerInstance.ts";
import type { McpCapability, McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Manifest from "./MissionRetroSourceManifest.ts";

/**
 * Bounded Retro source collection: immutable indexed/chunked bundles read
 * through the SUPPORTED `readThread` DTO shape with recovered text offsets
 * and explicit coverage/omissions. Native offline tests only: synthetic safe
 * fixtures, a callback sanitizer, and controlled stub reads. No live API,
 * no model, no sleeps or polling.
 */

const ORIGIN = "thread:origin";
const CHILD = "thread:child-9";
const NOW = "2026-10-14T03:00:00.000Z";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const parseJson = (bytes: string): unknown => decodeJson(bytes);

const scopeFor = (
  overrides: Partial<Manifest.MissionRetroSourceTrustedScope> = {},
): Manifest.MissionRetroSourceTrustedScope => ({
  teamId: "team:nofun",
  environmentId: "env:mac-1",
  missionId: "mission:one",
  checkpointId: "retro-ck-1",
  sourceRoot: "log:root-400",
  sourceThreadId: ORIGIN,
  allowedSourceThreadIds: [ORIGIN],
  fromInclusive: 0,
  toExclusive: 3,
  ...overrides,
});

const mcpScope = (): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env:mac-1"),
  capabilities: new Set<McpCapability>(["orchestration"]),
  issuedAt: Date.parse(NOW),
  requestNamespace: "retro-source-test",
  thread: undefined,
  client: undefined,
});

const allowAll: Manifest.MissionRetroSourceAuthorizer = (): Effect.Effect<
  void,
  Manifest.MissionRetroSourceManifestError
> => Effect.void;
const denyAll: Manifest.MissionRetroSourceAuthorizer = () =>
  Effect.fail(
    new Manifest.MissionRetroSourceManifestError({
      operation: "collect",
      category: "scope_denied",
      detail: "denied for test",
    }),
  );
const keepAll: Manifest.MissionRetroSourceSanitizer = (input) =>
  Effect.succeed({ kind: "kept", value: input.value });

const failSanitizer: Manifest.MissionRetroSourceSanitizer = () =>
  Effect.fail(
    new Manifest.MissionRetroSourceManifestError({
      operation: "collect",
      category: "sanitizer_failed",
      detail: "sanitizer exploded",
    }),
  );

const item = (
  position: number,
  overrides: Partial<OrchestratorMcpThreadTimelineItem> = {},
): OrchestratorMcpThreadTimelineItem => ({
  position,
  visibility: "local",
  sourceThreadId: ThreadId.make(ORIGIN),
  itemId: TurnItemId.make(`item-${position}`),
  runId: RunId.make("run-1"),
  messageId: MessageId.make(`msg-${position}`),
  createdBy: "agent",
  creationSource: "mcp",
  type: "assistant_message",
  status: "completed",
  title: null,
  text: `text-${position}`,
  textTruncated: false,
  nextTextOffset: null,
  updatedAt: NOW,
  ...overrides,
});

const run = (ordinal: number, status: "completed" | "running" = "completed"): OrchestratorMcpThreadRun => ({
  runId: RunId.make(`run-${ordinal}`),
  ordinal,
  status,
  providerInstanceId: "codex:gpt-6.1-sol" as ProviderInstanceId,
  model: "gpt-6.1-sol",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: status === "completed" ? NOW : null,
});

const page = (
  threadId: string,
  items: ReadonlyArray<OrchestratorMcpThreadTimelineItem>,
  overrides: Partial<OrchestratorMcpThreadReadResult> = {},
): OrchestratorMcpThreadReadResult => ({
  thread: {
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("project-1"),
    title: "origin work",
    createdBy: "agent",
    creationSource: "mcp",
    status: "running",
    latestRunId: RunId.make("run-1"),
    activeRunId: null,
    providerInstanceId: "codex:gpt-6.1-sol" as ProviderInstanceId,
    model: "gpt-6.1-sol",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 1,
    itemCount: items.length,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  recentRuns: [run(1)],
  items: [...items],
  nextPosition: items.length === 0 ? null : (items[items.length - 1]?.position ?? null),
  hasMore: false,
  ...overrides,
});

interface CallLog {
  readonly scopes: Array<McpInvocationScope>;
  readonly inputs: Array<OrchestratorMcpThreadReadInput>;
}

const scriptedReader = (
  log: CallLog,
  handlers: ReadonlyArray<
    (input: OrchestratorMcpThreadReadInput) => Effect.Effect<OrchestratorMcpThreadReadResult>
  >,
): Manifest.MissionRetroSourceReader => ({
  readThread: (scope, input) =>
    Effect.gen(function* () {
      log.scopes.push(scope);
      log.inputs.push(input);
      const handler:
        | ((input: OrchestratorMcpThreadReadInput) => Effect.Effect<OrchestratorMcpThreadReadResult>)
        | undefined = handlers[log.inputs.length - 1];
      if (handler === undefined) return yield* Effect.die(new Error("unexpected source read"));
      return yield* handler(input);
    }),
});

const collectInput = (
  log: CallLog,
  handlers: ReadonlyArray<
    (input: OrchestratorMcpThreadReadInput) => Effect.Effect<OrchestratorMcpThreadReadResult>
  >,
  overrides: Partial<Manifest.MissionRetroSourceCollectInput> = {},
): Manifest.MissionRetroSourceCollectInput => ({
  trustedScope: scopeFor(),
  mcpScope: mcpScope(),
  reader: scriptedReader(log, handlers),
  authorize: allowAll,
  sanitize: keepAll,
  ...overrides,
});

const categoryOf = (error: Manifest.MissionRetroSourceManifestError): string => error.category;

const coveredPositions = (bundle: Manifest.MissionRetroSourceBundle): ReadonlyArray<number> =>
  bundle.sourceRefs.flatMap((ref) => {
    const out: Array<number> = [];
    for (let p = ref.coveredFromInclusive; p < ref.coveredToExclusive; p += 1) out.push(p);
    return out;
  });

describe("MissionRetroSourceManifest", () => {
  it.effect("collects a full single-page window from position 0 without afterPosition", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const caller = mcpScope();
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(0), item(1), item(2)]))], {
          mcpScope: caller,
        }),
      );
      assert.strictEqual(log.inputs.length, 1);
      assert.notProperty(log.inputs[0], "afterPosition");
      assert.strictEqual(log.inputs[0]?.view, "activity");
      // The reader receives a captured snapshot: same identity values, not
      // the caller's mutable object pointer.
      assert.notStrictEqual(log.scopes[0], caller);
      assert.strictEqual(log.scopes[0]?.environmentId, caller.environmentId);
      assert.deepStrictEqual([...(log.scopes[0]?.capabilities ?? [])], [...caller.capabilities]);
      assert.strictEqual(log.scopes[0]?.requestNamespace, caller.requestNamespace);
      assert.strictEqual(log.scopes[0]?.issuedAt, caller.issuedAt);
      assert.strictEqual(bundle.apiCoverage, "full");
      assert.strictEqual(bundle.childLogCoverage, "unknown");
      assert.strictEqual(bundle.rawStdoutCoverage, "unknown");
      assert.isFalse(bundle.pendingChildRuns);
      assert.deepStrictEqual(bundle.omissions, []);
      assert.deepStrictEqual(bundle.uncoveredRanges, []);
      assert.deepStrictEqual(bundle.threadsRead, [ORIGIN]);
      assert.strictEqual(bundle.itemCount, 3);
      assert.strictEqual(bundle.sourceRefs.length, 1);
      const ref = bundle.sourceRefs[0];
      assert.strictEqual(ref?.rootRef, "log:root-400");
      assert.strictEqual(ref?.coveredFromInclusive, 0);
      assert.strictEqual(ref?.coveredToExclusive, 3);
      assert.strictEqual(
        bundle.artifactSha256,
        NodeCrypto.createHash("sha256").update(bundle.artifactBytes, "utf8").digest("hex"),
      );
      assert.strictEqual(bundle.artifactRef, `retro-source:${bundle.artifactSha256}`);
      assert.strictEqual(
        bundle.snapshotFingerprint,
        NodeCrypto.createHash("sha256").update(bundle.snapshotPreimage, "utf8").digest("hex"),
      );
      assert.include(bundle.artifactBytes, "text-0");
      assert.include(bundle.artifactBytes, "text-2");
    }));

  it.effect("pages an exclusive boundary from a nonzero start", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(
          log,
          [
            () => Effect.succeed(page(ORIGIN, [item(2), item(3)], { hasMore: true, nextPosition: 3 })),
            () =>
              Effect.succeed(page(ORIGIN, [item(4), item(5), item(6)], { hasMore: false, nextPosition: 6 })),
          ],
          { trustedScope: scopeFor({ fromInclusive: 2, toExclusive: 5 }) },
        ),
      );
      assert.strictEqual(log.inputs.length, 2);
      assert.strictEqual(log.inputs[0]?.afterPosition, 1);
      assert.strictEqual(log.inputs[1]?.afterPosition, 3);
      assert.strictEqual(bundle.apiCoverage, "full");
      assert.strictEqual(bundle.itemCount, 3);
      assert.include(bundle.artifactBytes, "text-2");
      assert.include(bundle.artifactBytes, "text-4");
      assert.notInclude(bundle.artifactBytes, "text-5");
      assert.notInclude(bundle.artifactBytes, "text-6");
      assert.deepStrictEqual(coveredPositions(bundle), [2, 3, 4]);
    }));

  it.effect("recovers truncated UTF-16 text across exact offsets", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const full = "a😀b";
      assert.strictEqual(full.length, 4);
      const first = item(0, { text: full.slice(0, 2), textTruncated: true, nextTextOffset: 2 });
      const rest = item(0, { text: full.slice(2), textTruncated: false, nextTextOffset: null });
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(
          log,
          [
            () => Effect.succeed(page(ORIGIN, [first], { hasMore: false })),
            () => Effect.succeed(page(ORIGIN, [rest], { hasMore: false })),
          ],
          { trustedScope: scopeFor({ toExclusive: 1 }) },
        ),
      );
      assert.strictEqual(log.inputs.length, 2);
      assert.strictEqual(log.inputs[1]?.itemId, "item-0");
      assert.strictEqual(log.inputs[1]?.textOffset, 2);
      assert.strictEqual(bundle.apiCoverage, "full");
      const parsed = parseJson(bundle.artifactBytes) as {
        readonly chunks: ReadonlyArray<{ readonly items: ReadonlyArray<{ readonly text: string }> }>;
      };
      assert.strictEqual(parsed.chunks[0]?.items[0]?.text, full);
    }));

  it.effect("hashes actual sanitized bytes deterministically and detaches inputs", () =>
    Effect.gen(function* () {
      const fixture = (): Array<OrchestratorMcpThreadTimelineItem> => [
        item(0),
        item(1, { title: "kept title" }),
      ];
      const runOnce = (): Effect.Effect<
        Manifest.MissionRetroSourceBundle,
        Manifest.MissionRetroSourceManifestError
      > => {
        const log: CallLog = { scopes: [], inputs: [] };
        return Manifest.collectRetroSources(
          collectInput(log, [() => Effect.succeed(page(ORIGIN, fixture()))]),
        );
      };
      const first = yield* runOnce();
      const second = yield* runOnce();
      assert.strictEqual(second.artifactBytes, first.artifactBytes);
      assert.strictEqual(second.artifactSha256, first.artifactSha256);
      assert.strictEqual(second.snapshotFingerprint, first.snapshotFingerprint);
      const parsed = parseJson(first.artifactBytes) as {
        readonly chunks: ReadonlyArray<{
          readonly chunkRef: string;
          readonly chunkHash: string;
          readonly threadId: string;
          readonly coveredFromInclusive: number;
          readonly coveredToExclusive: number;
          readonly items: unknown;
        }>;
      };
      for (const chunk of parsed.chunks) {
        const { chunkRef: _ref, chunkHash: expected, ...payload } = chunk;
        void _ref;
        assert.strictEqual(
          NodeCrypto.createHash("sha256").update(stableStringify(payload), "utf8").digest("hex"),
          expected,
        );
      }
      const tampered = fixture();
      tampered[0] = item(0, { text: "mutated-after-collect" });
      assert.notInclude(first.artifactBytes, "mutated-after-collect");
      assert.isTrue(Object.isFrozen(first.sourceRefs));
      assert.isTrue(Object.isFrozen(first.omissions));
      assert.isTrue(Object.isFrozen(first.uncoveredRanges));
    }));

  it.effect("retains failed attempts and user corrections instead of preferring final success", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [
          () =>
            Effect.succeed(
              page(ORIGIN, [
                item(0, { type: "assistant_message", status: "failed", text: "attempt one broke" }),
                item(1, { type: "user_message", status: "completed", text: "no, do the other thing" }),
                item(2, { type: "assistant_message", status: "completed", text: "final result" }),
              ]),
            ),
        ]),
      );
      assert.strictEqual(bundle.apiCoverage, "full");
      assert.strictEqual(bundle.itemCount, 3);
      assert.include(bundle.artifactBytes, "attempt one broke");
      assert.include(bundle.artifactBytes, "no, do the other thing");
      assert.include(bundle.artifactBytes, "final result");
    }));

  it.effect("denies before any API call when the trusted gate refuses", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const error = yield* Effect.flip(
        Manifest.collectRetroSources(collectInput(log, [], { authorize: denyAll })),
      );
      assert.strictEqual(categoryOf(error), "scope_denied");
      assert.strictEqual(log.inputs.length, 0);
    }));

  it.effect("denies invalid scope and missing gates before any API call", () =>
    Effect.gen(function* () {
      const empty: CallLog = { scopes: [], inputs: [] };
      const badScope = yield* Effect.flip(
        Manifest.collectRetroSources(collectInput(empty, [], { trustedScope: scopeFor({ teamId: "  " }) })),
      );
      assert.strictEqual(categoryOf(badScope), "scope_denied");
      const missing: CallLog = { scopes: [], inputs: [] };
      const noSanitizer = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(missing, [], {
            sanitize: undefined as unknown as Manifest.MissionRetroSourceSanitizer,
          }),
        ),
      );
      assert.strictEqual(categoryOf(noSanitizer), "sanitizer_unavailable");
      assert.strictEqual(empty.inputs.length, 0);
      assert.strictEqual(missing.inputs.length, 0);
    }));

  it.effect("exports nothing when the trusted sanitizer fails", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const error = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(0), item(1)]))], {
            sanitize: failSanitizer,
          }),
        ),
      );
      assert.strictEqual(categoryOf(error), "sanitizer_failed");
    }));

  it.effect("records structured omissions for withheld content without echoing it", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const redacting: Manifest.MissionRetroSourceSanitizer = (input) =>
        input.itemType === "compaction" && input.field === "text"
          ? Effect.succeed({ kind: "omitted", cause: "private reasoning withheld" })
          : Effect.succeed({ kind: "kept", value: input.value });
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(
          log,
          [
            () =>
              Effect.succeed(
                page(ORIGIN, [
                  item(0),
                  item(1, { type: "compaction", status: "completed", text: "secret-summary" }),
                  item(2),
                ]),
              ),
          ],
          { sanitize: redacting },
        ),
      );
      assert.strictEqual(bundle.apiCoverage, "partial");
      assert.notInclude(bundle.artifactBytes, "secret-summary");
      assert.strictEqual(bundle.omissions.length, 1);
      assert.include(bundle.omissions[0] ?? "", "pos 1 type compaction");
      assert.include(bundle.omissions[0] ?? "", "private reasoning withheld");
      assert.deepStrictEqual([...bundle.uncoveredRanges], [{ fromInclusive: 1, toExclusive: 2 }]);
      assert.deepStrictEqual(coveredPositions(bundle), [0, 2]);
    }));

  it.effect("rejects a cursor cycle that repeats a position", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const error = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(
            log,
            [
              () => Effect.succeed(page(ORIGIN, [item(0), item(1)], { hasMore: true, nextPosition: 1 })),
              () => Effect.succeed(page(ORIGIN, [item(1)], { hasMore: true, nextPosition: 1 })),
            ],
            { trustedScope: scopeFor({ toExclusive: 4 }) },
          ),
        ),
      );
      assert.strictEqual(categoryOf(error), "source_rejected");
    }));

  it.effect("rejects a text-offset cycle that never advances", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const shrinking = "abcdefgh";
      const first = item(0, { text: shrinking.slice(0, 4), textTruncated: true, nextTextOffset: 4 });
      const stalled = item(0, { text: shrinking.slice(4), textTruncated: true, nextTextOffset: 4 });
      const error = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(
            log,
            [
              () => Effect.succeed(page(ORIGIN, [first], { hasMore: false })),
              () => Effect.succeed(page(ORIGIN, [stalled], { hasMore: false })),
            ],
            { trustedScope: scopeFor({ toExclusive: 1 }) },
          ),
        ),
      );
      assert.strictEqual(categoryOf(error), "source_rejected");
    }));

  it.effect("rejects a mid-read mutation coordinated through a Deferred handoff", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const entered = yield* Deferred.make<void>();
      const LATER = "2026-10-14T04:00:00.000Z";
      const first = item(0, { text: "abcdefgh".slice(0, 4), textTruncated: true, nextTextOffset: 4 });
      const reader: Manifest.MissionRetroSourceReader = {
        readThread: (scope, input) =>
          Effect.gen(function* () {
            log.scopes.push(scope);
            log.inputs.push(input);
            if (log.inputs.length === 1) return page(ORIGIN, [first], { hasMore: false });
            yield* Deferred.succeed(entered, undefined);
            return page(ORIGIN, [{ ...item(0), updatedAt: LATER }], { hasMore: false });
          }),
      };
      const error = yield* Effect.flip(
        Manifest.collectRetroSources({
          trustedScope: scopeFor({ toExclusive: 1 }),
          mcpScope: mcpScope(),
          reader,
          authorize: allowAll,
          sanitize: keepAll,
        }),
      );
      assert.strictEqual(categoryOf(error), "source_rejected");
      yield* Deferred.await(entered);
      assert.strictEqual(log.inputs.length, 2);
    }));

  it.effect("returns explicit partial with retained gaps on budget exhaustion", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(
          log,
          [() => Effect.succeed(page(ORIGIN, [item(0), item(1)], { hasMore: true, nextPosition: 1 }))],
          {
            trustedScope: scopeFor({ toExclusive: 4 }),
            budget: { maxPages: 1, maxItems: 400, maxBytes: 1_048_576, maxChunks: 16 },
          },
        ),
      );
      assert.strictEqual(log.inputs.length, 1);
      assert.strictEqual(bundle.apiCoverage, "partial");
      assert.deepStrictEqual([...bundle.uncoveredRanges], [{ fromInclusive: 2, toExclusive: 4 }]);
      assert.isTrue(bundle.omissions.some((note) => note.includes("budget exhausted")));
      assert.deepStrictEqual(coveredPositions(bundle), [0, 1]);
    }));

  it.effect("keeps child and stdout coverage unknown and never auto-expands child threads", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(
          log,
          [() => Effect.succeed(page(ORIGIN, [item(0), item(1)], { recentRuns: [run(1), run(2, "running")] }))],
          { trustedScope: scopeFor({ toExclusive: 2 }) },
        ),
      );
      assert.strictEqual(bundle.apiCoverage, "full");
      assert.isTrue(bundle.pendingChildRuns);
      assert.strictEqual(bundle.childLogCoverage, "unknown");
      assert.strictEqual(bundle.rawStdoutCoverage, "unknown");
      for (const input of log.inputs) assert.strictEqual(input.threadId, ORIGIN);
      assert.notInclude(bundle.artifactBytes, CHILD);
    }));

  it.effect("reads only the primary window while permitting inherited child items", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(
          log,
          [
            () =>
              Effect.succeed(
                page(ORIGIN, [
                  item(0),
                  item(1, { sourceThreadId: ThreadId.make(CHILD), visibility: "inherited" }),
                  item(2),
                ]),
              ),
          ],
          {
            trustedScope: scopeFor({ allowedSourceThreadIds: [ORIGIN, CHILD] }),
          },
        ),
      );
      assert.strictEqual(bundle.apiCoverage, "full");
      assert.deepStrictEqual(bundle.threadsRead, [ORIGIN]);
      assert.isTrue(log.inputs.every((input) => input.threadId === ORIGIN));
      assert.include(bundle.snapshotPreimage, ORIGIN);
      assert.deepStrictEqual(coveredPositions(bundle), [0, 1, 2]);
    }));

  it.effect("exposes exact chunk bytes that verify against the manifest hash", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(0), item(1), item(2)]))]),
      );
      assert.strictEqual(bundle.chunkArtifacts.length, bundle.sourceRefs.length);
      for (const [index, chunk] of bundle.chunkArtifacts.entries()) {
        assert.strictEqual(
          NodeCrypto.createHash("sha256").update(chunk.chunkBytes, "utf8").digest("hex"),
          chunk.chunkHash,
        );
        assert.strictEqual(chunk.chunkHash, bundle.sourceRefs[index]?.chunkHash);
        assert.strictEqual(chunk.chunkRef, bundle.sourceRefs[index]?.chunkRef);
        assert.isTrue(Object.isFrozen(chunk));
      }
      assert.isTrue(Object.isFrozen(bundle.chunkArtifacts));
      assert.isTrue(Object.isFrozen(bundle.sourceRefs[0]));
      assert.isTrue(Object.isFrozen(bundle.uncoveredRanges));
    }));

  it.effect("fits 400 contiguous short items within the 16 chunk bound", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const all = Array.from({ length: 400 }, (_, position) => item(position));
      const handler = (input: OrchestratorMcpThreadReadInput) =>
        Effect.succeed(
          (() => {
            const start = input.afterPosition === undefined ? 0 : input.afterPosition + 1;
            const slice = all.slice(start, start + 100);
            const base = page(ORIGIN, slice, {
              hasMore: start + slice.length < 400,
              nextPosition: slice.length === 0 ? null : (slice[slice.length - 1]?.position ?? null),
            });
            return { ...base, thread: { ...base.thread, itemCount: 400, runCount: 1 } };
          })(),
        );
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [handler, handler, handler, handler], {
          trustedScope: scopeFor({ toExclusive: 400 }),
        }),
      );
      assert.strictEqual(bundle.apiCoverage, "full");
      assert.strictEqual(bundle.itemCount, 400);
      assert.isTrue(bundle.sourceRefs.length <= 16);
      assert.deepStrictEqual(coveredPositions(bundle).length, 400);
    }));

  it.effect("keeps the captured principal when the caller mutates its scope mid-read", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const caller = mcpScope();
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(
          log,
          [
            () => {
              (caller.capabilities as Set<McpCapability>).clear();
              (caller as { environmentId: unknown }).environmentId = EnvironmentId.make("foreign-environment");
              return Effect.succeed(page(ORIGIN, [item(0), item(1), item(2)]));
            },
          ],
          { mcpScope: caller },
        ),
      );
      assert.strictEqual(bundle.apiCoverage, "full");
      assert.strictEqual(log.scopes[0]?.environmentId as unknown as string, "env:mac-1");
      assert.isTrue(log.scopes[0]?.capabilities.has("orchestration"));
    }));

  it.effect("does not certify no pending runs from truncated run history", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const base = page(ORIGIN, [item(0), item(1), item(2)]);
      const truncated = { ...base, thread: { ...base.thread, runCount: 5, pendingRequestCount: 0, activeRunId: null } };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [() => Effect.succeed(truncated)]),
      );
      assert.isTrue(bundle.pendingChildRuns);
      assert.isFalse(bundle.pendingChildRunsKnown);
      assert.strictEqual(bundle.childLogCoverage, "unknown");
    }));

  it.effect("rejects a jumping API cursor instead of forging coverage", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const error = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(
            log,
            [() => Effect.succeed(page(ORIGIN, [item(0), item(1)], { hasMore: true, nextPosition: 999 }))],
            { trustedScope: scopeFor({ toExclusive: 4 }) },
          ),
        ),
      );
      assert.strictEqual(categoryOf(error), "source_rejected");
    }));

  it.effect("ignores appended items beyond the window but leaves its tail uncovered", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(0), item(1), item(9)]))]),
      );
      assert.strictEqual(bundle.apiCoverage, "partial");
      assert.deepStrictEqual([...bundle.uncoveredRanges], [{ fromInclusive: 2, toExclusive: 3 }]);
      assert.deepStrictEqual(coveredPositions(bundle), [0, 1]);
      assert.notInclude(bundle.artifactBytes, "text-9");
    }));

  it.effect("caps the final artifact bytes and denies a budget too small for metadata", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const big = Array.from({ length: 3 }, (_, position) =>
        item(position, { text: "x".repeat(2_000) }),
      );
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [() => Effect.succeed(page(ORIGIN, big))], {
          budget: { maxPages: 32, maxItems: 400, maxBytes: 4_000, maxChunks: 16 },
        }),
      );
      assert.strictEqual(bundle.apiCoverage, "partial");
      assert.isTrue(Buffer.byteLength(bundle.artifactBytes, "utf8") <= 4_000);
      assert.isTrue(bundle.uncoveredRanges.length > 0);
      const tinyLog: CallLog = { scopes: [], inputs: [] };
      const denied = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(tinyLog, [() => Effect.succeed(page(ORIGIN, [item(0)]))], {
            trustedScope: scopeFor({ toExclusive: 1 }),
            budget: { maxPages: 32, maxItems: 400, maxBytes: 100, maxChunks: 16 },
          }),
        ),
      );
      assert.strictEqual(categoryOf(denied), "scope_denied");
    }));

  it.effect("keeps omission notes inside the cap while marking every lost position", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const omitAll: Manifest.MissionRetroSourceSanitizer = (input) =>
        input.field === "text"
          ? Effect.succeed({ kind: "omitted", cause: "private content withheld" })
          : Effect.succeed({ kind: "kept", value: input.value });
      const many = Array.from({ length: 20 }, (_, position) => item(position));
      const bundle = yield* Manifest.collectRetroSources(
        collectInput(log, [() => Effect.succeed(page(ORIGIN, many))], {
          trustedScope: scopeFor({ toExclusive: 20 }),
          sanitize: omitAll,
        }),
      );
      assert.strictEqual(bundle.apiCoverage, "partial");
      assert.isTrue(bundle.omissions.length <= 16);
      assert.deepStrictEqual([...bundle.uncoveredRanges], [{ fromInclusive: 0, toExclusive: 20 }]);
      assert.strictEqual(bundle.sourceRefs.length, 0);
    }));

  it.effect("rejects a recovery fragment whose message identity changed", () =>
    Effect.gen(function* () {
      const log: CallLog = { scopes: [], inputs: [] };
      const first = item(0, { text: "abcd", textTruncated: true, nextTextOffset: 4 });
      const changed = item(0, {
        text: "efgh",
        messageId: MessageId.make("msg-changed"),
        textTruncated: false,
        nextTextOffset: null,
      });
      const error = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(
            log,
            [
              () => Effect.succeed(page(ORIGIN, [first], { hasMore: false })),
              () => Effect.succeed(page(ORIGIN, [changed], { hasMore: false })),
            ],
            { trustedScope: scopeFor({ toExclusive: 1 }) },
          ),
        ),
      );
      assert.strictEqual(categoryOf(error), "source_rejected");
    }));

  it.effect("rejects foreign sources and wrong returned targets", () =>
    Effect.gen(function* () {
      const foreignLog: CallLog = { scopes: [], inputs: [] };
      const foreign = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(foreignLog, [
            () => Effect.succeed(page(ORIGIN, [item(0, { sourceThreadId: ThreadId.make("thread:intruder") })])),
          ]),
        ),
      );
      assert.strictEqual(categoryOf(foreign), "source_rejected");
      const targetLog: CallLog = { scopes: [], inputs: [] };
      const wrongTarget = yield* Effect.flip(
        Manifest.collectRetroSources(
          collectInput(targetLog, [() => Effect.succeed(page("thread:other", [item(0)]))]),
        ),
      );
      assert.strictEqual(categoryOf(wrongTarget), "source_rejected");
    }));
});

it.effect("root regression: cannot certify an unread window when the first returned item is beyond it", () =>
  Effect.gen(function* () {
    const log: CallLog = { scopes: [], inputs: [] };
    const bundle = yield* Manifest.collectRetroSources(
      collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(8)]))]),
    );
    assert.notStrictEqual(bundle.apiCoverage, "full");
    assert.deepStrictEqual(bundle.uncoveredRanges, [{ fromInclusive: 0, toExclusive: 3 }]);
    assert.strictEqual(bundle.sourceRefs.length, 0);
  }),
);

it.effect("root regression: rejects a caller environment different from the trusted boundary before reads", () =>
  Effect.gen(function* () {
    const log: CallLog = { scopes: [], inputs: [] };
    const denied = yield* Effect.flip(Manifest.collectRetroSources(
      collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(0), item(1), item(2)]))], {
        mcpScope: { ...mcpScope(), environmentId: EnvironmentId.make("foreign-environment") },
      }),
    ));
    assert.strictEqual(denied.category, "scope_denied");
    assert.strictEqual(log.inputs.length, 0);
  }),
);

it.effect("root regression: returned source reference entries cannot be mutated independently of their hashed artifact", () =>
  Effect.gen(function* () {
    const log: CallLog = { scopes: [], inputs: [] };
    const bundle = yield* Manifest.collectRetroSources(
      collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(0), item(1), item(2)]))]),
    );
    const ref = bundle.sourceRefs[0]!;
    const original = ref.chunkHash;
    assert.isFalse(Reflect.set(ref, "chunkHash", "0".repeat(64)));
    assert.strictEqual(ref.chunkHash, original);
  }),
);

it.effect("root final regression: rejects a foreign target on a text-recovery response", () =>
  Effect.gen(function* () {
    const log: CallLog = { scopes: [], inputs: [] };
    const outcome = yield* Effect.result(Manifest.collectRetroSources(
      collectInput(log, [
        () => Effect.succeed(page(ORIGIN, [item(0, { text: "a", textTruncated: true, nextTextOffset: 1 })])),
        () => Effect.succeed(page(CHILD, [item(0, { text: "b", textTruncated: false, nextTextOffset: null })])),
      ], { trustedScope: scopeFor({ toExclusive: 1 }) }),
    ));
    assert.isTrue(Result.isFailure(outcome));
    if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure.category, "source_rejected");
  }),
);

it.effect("root final regression: does not echo diagnostics from external sanitizer errors", () =>
  Effect.gen(function* () {
    const log: CallLog = { scopes: [], inputs: [] };
    const denied = yield* Effect.flip(Manifest.collectRetroSources(
      collectInput(log, [() => Effect.succeed(page(ORIGIN, [item(0), item(1), item(2)]))], {
        sanitize: () => Effect.fail(new Manifest.MissionRetroSourceManifestError({
          operation: "collect", category: "sanitizer_failed", detail: "synthetic-sensitive-source-diagnostic",
        })),
      }),
    ));
    assert.strictEqual(denied.category, "sanitizer_failed");
    assert.notInclude(denied.detail ?? "", "synthetic-sensitive-source-diagnostic");
  }),
);
