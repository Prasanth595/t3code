// @effect-diagnostics nodeBuiltinImport:off - owns the scoped native worker pool.
import * as NodeOS from "node:os";
import * as NodeWorkerThreads from "node:worker_threads";

import type { TranscriptUsageFormat, UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Pool from "effect/Pool";
import * as Schema from "effect/Schema";

import {
  GUARD_LENGTH,
  READ_BUFFER_BYTES,
  STREAMING_THRESHOLD_BYTES,
  readTranscriptRecords,
  type TranscriptParsePosition,
  type TranscriptParseResult,
} from "./usageTranscriptReader.ts";
import {
  projectionWorkerSource,
  type ProjectionReply,
  type ProjectionRequest,
} from "./usageTranscriptWorker.ts";

class TranscriptWorkerError extends Schema.TaggedError<TranscriptWorkerError>()(
  "TranscriptWorkerError",
  {
    operation: Schema.Literals(["spawn", "read", "decode"]),
    cause: Schema.Defect(),
  },
) {}

type ParsedReply = Extract<ProjectionReply, { readonly kind: "parsed" }>;
const projectionDecoders = new WeakMap<object, (reply: ParsedReply) => TranscriptParseResult>();

function makeProjectionDecoder<State>(format: TranscriptUsageFormat<State>) {
  const codec = format.state;
  const encode = codec === undefined ? undefined : Schema.encodeSync(codec.schema);
  const decode = codec === undefined ? undefined : Schema.decodeUnknownOption(codec.schema);
  return (reply: ParsedReply): TranscriptParseResult => {
    const state = codec === undefined ? (undefined as State) : codec.initial();
    const records: UsageRecord[] = [];
    for (const value of reply.records) {
      for (const record of format.parseProjected(value, state)) records.push(record);
    }
    const encoded = encode === undefined ? null : encode(state);
    const tailState = decode === undefined ? state : Option.getOrThrow(decode(encoded));
    const tailRecords: UsageRecord[] = [];
    for (const value of reply.tailRecords) {
      for (const record of format.parseProjected(value, tailState)) tailRecords.push(record);
    }
    return {
      records,
      tailRecords,
      position: { ...reply.position, state: encoded },
      resumed: false,
    };
  };
}

function decodeProjection<State>(reply: ParsedReply, format: TranscriptUsageFormat<State>) {
  let decode = projectionDecoders.get(format);
  if (decode === undefined) {
    decode = makeProjectionDecoder(format);
    projectionDecoders.set(format, decode);
  }
  return decode(reply);
}

export const make = Effect.gen(function* () {
  // Leave a core for the server and reduce parallelism on small hosts.
  const constrainedMemory = process.constrainedMemory();
  const memory =
    constrainedMemory > 0 ? Math.min(NodeOS.totalmem(), constrainedMemory) : NodeOS.totalmem();
  const workerCount = Math.min(
    4,
    NodeOS.availableParallelism() - 1,
    Math.floor(memory / (2 * 1024 ** 3)),
  );
  const direct = <State>(
    filePath: string,
    format: TranscriptUsageFormat<State>,
    resumeFrom?: TranscriptParsePosition,
  ) => Effect.promise(() => readTranscriptRecords(filePath, format, resumeFrom));
  if (workerCount <= 0) return direct;

  let unavailable = false;
  const workers = yield* Pool.makeWithTTL({
    min: 0,
    max: workerCount,
    targetUtilization: 1,
    timeToLive: "1 second",
    acquire: Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (unavailable) {
            throw new TranscriptWorkerError({ operation: "spawn", cause: "Worker unavailable" });
          }
          const worker = new NodeWorkerThreads.Worker(projectionWorkerSource, {
            eval: true,
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 },
          });
          let failure: unknown;
          worker.on("error", (cause: unknown) => {
            failure = cause;
          });
          worker.on("exit", (code) => {
            failure = { exitCode: code };
          });
          worker.unref();
          return {
            worker,
            get failure() {
              return failure;
            },
          };
        },
        catch: (cause) => {
          unavailable = true;
          return new TranscriptWorkerError({ operation: "spawn", cause });
        },
      }),
      ({ worker }) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
    ),
  });

  return Effect.fnUntraced(function* <State>(
    filePath: string,
    format: TranscriptUsageFormat<State>,
    resumeFrom?: TranscriptParsePosition,
  ) {
    // Appended bytes are cheap already and need the original reducer state.
    if ((resumeFrom?.resumeOffset ?? 0) > 0 || unavailable) {
      return yield* direct(filePath, format, resumeFrom);
    }
    const reply = yield* Pool.use(workers, (slot) =>
      Effect.callback<ProjectionReply, TranscriptWorkerError>((resume) => {
        if (slot.failure !== undefined) {
          resume(
            Effect.fail(new TranscriptWorkerError({ operation: "read", cause: slot.failure })),
          );
          return;
        }
        const cleanup = () => {
          slot.worker.off("message", onMessage);
          slot.worker.off("error", onError);
          slot.worker.off("exit", onExit);
          slot.worker.unref();
        };
        const onMessage = (value: ProjectionReply) => {
          cleanup();
          resume(Effect.succeed(value));
        };
        const onError = (cause: unknown) => {
          unavailable = true;
          cleanup();
          resume(Effect.fail(new TranscriptWorkerError({ operation: "read", cause })));
        };
        const onExit = (exitCode: number) => onError({ exitCode });
        slot.worker.once("message", onMessage);
        slot.worker.once("error", onError);
        slot.worker.once("exit", onExit);
        slot.worker.ref();
        const request: ProjectionRequest = {
          filePath,
          markers: format.usageMarkers,
          fields: format.selectFields,
          lineLimit: STREAMING_THRESHOLD_BYTES,
          readBufferBytes: READ_BUFFER_BYTES,
          guardBytes: GUARD_LENGTH,
        };
        try {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker IPC has no targetOrigin.
          slot.worker.postMessage(request);
        } catch (cause) {
          onError(cause);
        }
        return Effect.sync(cleanup);
      }).pipe(
        Effect.onError(() => Pool.invalidate(workers, slot)),
        Effect.onInterrupt(() => Pool.invalidate(workers, slot)),
      ),
    ).pipe(
      Effect.catchTags({
        TranscriptWorkerError: () =>
          Effect.sync(() => {
            unavailable = true;
            return { kind: "fallback" } as const;
          }),
      }),
    );
    if (reply.kind === "fallback") return yield* direct(filePath, format);
    if (reply.kind === "unreadable") return null;
    return yield* Effect.try({
      try: () => decodeProjection(reply, format),
      catch: (cause) => new TranscriptWorkerError({ operation: "decode", cause }),
    }).pipe(Effect.catchTags({ TranscriptWorkerError: () => direct(filePath, format) }));
  });
});
