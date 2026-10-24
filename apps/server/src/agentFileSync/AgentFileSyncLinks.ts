// @effect-diagnostics nodeBuiltinImport:off -- Subscriptions use random durable identifiers.
import * as NodeCrypto from "node:crypto";
import {
  AgentFileSyncBundle,
  AgentFileSyncError,
  AgentFileSyncLink,
  type AgentFileSyncSubscribeInput,
  type AgentFileSyncRefreshInput,
  type AgentFileSyncManageInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AgentFileSync from "./AgentFileSync.ts";

type State = readonly (AgentFileSyncLink & { readonly previous: AgentFileSyncBundle })[];
const SavedLinks = Schema.Array(AgentFileSyncLink);
const encode = Schema.encodeSync(Schema.fromJsonString(SavedLinks));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedLinks));
const encodeBundle = Schema.encodeSync(Schema.fromJsonString(AgentFileSyncBundle));
const decodeBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentFileSyncBundle));
const bundleRevision = (bundle: typeof AgentFileSyncBundle.Type) =>
  NodeCrypto.createHash("sha256").update(encodeBundle(bundle)).digest("hex");
const SECRET = "agent-file-sync-links";
const baselineKey = (link: AgentFileSyncLink) =>
  `agent-file-sync-baseline-${NodeCrypto.createHash("sha256").update(`${link.id}\0${link.revision}`).digest("hex")}`;

export class AgentFileSyncLinks extends Context.Service<
  AgentFileSyncLinks,
  {
    readonly list: Effect.Effect<readonly AgentFileSyncLink[]>;
    readonly subscribe: <E = never, R = never>(
      input: AgentFileSyncSubscribeInput,
      beforeWrite?: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<void, AgentFileSyncError | E, R>;
    readonly refresh: (input: AgentFileSyncRefreshInput) => Effect.Effect<void, AgentFileSyncError>;
    readonly manage: <E = never, R = never>(
      input: AgentFileSyncManageInput,
      beforeWrite?: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<void, AgentFileSyncError | E, R>;
  }
>()("t3/agentFileSync/AgentFileSyncLinks") {}

const make = Effect.gen(function* () {
  const files = yield* AgentFileSync.AgentFileSync;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const home = yield* HostProcess.HomeDirectory;
  const stored = yield* secrets.get(SECRET);
  const metadata = Option.isSome(stored)
    ? yield* decode(Buffer.from(stored.value).toString("utf8")).pipe(
        Effect.tapError(() =>
          Effect.logWarning("Ignoring unreadable agent file sync subscriptions"),
        ),
        Effect.orElseSucceed(() => []),
      )
    : [];
  const loadBaseline = Effect.fn("AgentFileSyncLinks.loadBaseline")(
    function* (link: AgentFileSyncLink) {
      const baseline = yield* secrets.get(baselineKey(link));
      if (Option.isNone(baseline)) return yield* new AgentFileSyncError({ reason: "io" });
      const previous = yield* decodeBundle(Buffer.from(baseline.value).toString("utf8"));
      if (bundleRevision(previous) !== link.revision)
        return yield* new AgentFileSyncError({ reason: "changed" });
      return { ...link, previous };
    },
    Effect.catch(() =>
      Effect.logWarning("Ignoring an unreadable agent file sync baseline").pipe(Effect.as(null)),
    ),
  );
  let state: State = (yield* Effect.forEach(metadata, loadBaseline)).filter(
    (link) => link !== null,
  );
  const lock = yield* Semaphore.make(1);
  const persist = Effect.fn("AgentFileSyncLinks.persist")(function* (next: State) {
    const oldKeys = new Set(state.map(baselineKey));
    const nextKeys = new Set(next.map(baselineKey));
    // Publish immutable baselines before the catalog so interrupted writes leave the prior state readable.
    for (const link of next) {
      if (oldKeys.has(baselineKey(link))) continue;
      yield* secrets
        .set(baselineKey(link), Buffer.from(encodeBundle(link.previous)))
        .pipe(Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })));
    }
    yield* secrets
      .set(SECRET, Buffer.from(encode(next.map(({ previous: _previous, ...link }) => link))))
      .pipe(Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })));
    state = next;
    for (const key of oldKeys) {
      if (nextKeys.has(key)) continue;
      yield* secrets
        .remove(key)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not remove an obsolete agent file sync baseline"),
          ),
        );
    }
  });
  // File contents stay on the destination. Clients only need the selection and generation.
  const list = Effect.sync(() => state.map(({ previous: _previous, ...link }) => link));
  const subscribe: AgentFileSyncLinks["Service"]["subscribe"] = Effect.fn(
    "AgentFileSyncLinks.subscribe",
  )(function* <E = never, R = never>(
    input: AgentFileSyncSubscribeInput,
    beforeWrite?: Effect.Effect<unknown, E, R>,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (state.length >= 20)
          return yield* new AgentFileSyncError({ reason: "subscription-limit" });
        const destination = yield* fs
          .realPath(input.cwd ?? home)
          .pipe(Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })));
        for (const job of state) {
          const existing = yield* fs
            .realPath(job.scope.cwd ?? home)
            .pipe(Effect.orElseSucceed(() => null));
          if (
            existing === destination &&
            job.previous.some((resource) =>
              input.bundle.some((item) => item.path === resource.path),
            )
          )
            return yield* new AgentFileSyncError({ reason: "overlap" });
        }
        const result = yield* files.apply(input, false, beforeWrite);
        if (result.failures.length)
          return yield* new AgentFileSyncError({ reason: "io", path: result.failures[0]!.path });
        yield* persist([
          ...state,
          {
            id: NodeCrypto.randomUUID(),
            scope: input.cwd ? { cwd: input.cwd } : {},
            sourceEnvironmentId: input.sourceEnvironmentId,
            selection: input.selection,
            label: input.label,
            previous: input.bundle,
            paused: false,
            error: null,
            lastSyncedAt: yield* Clock.currentTimeMillis,
            generation: 0,
            revision: bundleRevision(input.bundle),
          },
        ]);
      }),
    );
  });
  const refresh: AgentFileSyncLinks["Service"]["refresh"] = Effect.fn("AgentFileSyncLinks.refresh")(
    function* (input) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const job = state.find((entry) => entry.id === input.id);
          // Several clients may relay the same subscription. A stale client must re-read it.
          if (!job || job.paused || job.generation !== input.generation) return;
          const result = yield* files
            .reconcile({
              ...job.scope,
              previous: job.previous,
              bundle: input.bundle ?? job.previous,
            })
            .pipe(Effect.result);
          if (result._tag === "Success" && input.bundle === null && job.error === null) return;
          const next =
            result._tag === "Success"
              ? {
                  ...job,
                  previous: input.bundle ?? job.previous,
                  revision: input.bundle ? bundleRevision(input.bundle) : job.revision,
                  error: null,
                  lastSyncedAt: yield* Clock.currentTimeMillis,
                  generation: job.generation + 1,
                }
              : {
                  ...job,
                  error: result.failure.message,
                  paused: true,
                  generation: job.generation + 1,
                };
          yield* persist(state.map((entry) => (entry.id === job.id ? next : entry)));
          if (result._tag === "Failure") return yield* result.failure;
        }),
      );
    },
  );
  const manage: AgentFileSyncLinks["Service"]["manage"] = Effect.fn("AgentFileSyncLinks.manage")(
    function* <E = never, R = never>(
      input: AgentFileSyncManageInput,
      beforeWrite?: Effect.Effect<unknown, E, R>,
    ) {
      return yield* lock.withPermit(
        Effect.andThen(
          beforeWrite ?? Effect.void,
          Effect.suspend(() =>
            persist(
              input.action === "remove"
                ? state.filter((job) => job.id !== input.id)
                : state.map((job) =>
                    job.id === input.id
                      ? {
                          ...job,
                          paused: input.action === "pause",
                          error: input.action === "pause" ? (input.error ?? null) : null,
                          generation: job.generation + 1,
                        }
                      : job,
                  ),
            ),
          ),
        ),
      );
    },
  );
  return AgentFileSyncLinks.of({ list, subscribe, refresh, manage });
});
export const layer = Layer.effect(AgentFileSyncLinks, make);
