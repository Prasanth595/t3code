import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";

/**
 * The persisted runtime record a server writes for the T3 home it owns. It
 * names the pid, the port and the origin of that server.
 */
export const DesktopServerRuntimeRecord = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type DesktopServerRuntimeRecord = typeof DesktopServerRuntimeRecord.Type;

const decodeServerRuntimeRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopServerRuntimeRecord),
);

/**
 * How the recorded owner of the T3 home relates to this desktop app.
 *
 * - `none`: nobody owns the home. The desktop may start its own server.
 * - `healthy`: a server is running, serving this same T3 home, and answering
 *   its environment descriptor. The desktop must not start a second writer.
 * - `stranded`: a server is running and holds the home's ownership lock, but
 *   it is not answering. A desktop-owned server in this state is the leftover
 *   of a previous desktop run and can be recovered.
 * - `foreign`: a server owns the home and is not answering, but it is not
 *   provably this desktop's own leftover. It is left alone.
 */
export type DesktopServerOwner =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "healthy";
      readonly record: DesktopServerRuntimeRecord;
      readonly httpBaseUrl: URL;
    }
  | {
      readonly _tag: "stranded";
      readonly record: DesktopServerRuntimeRecord;
    }
  | {
      readonly _tag: "foreign";
      readonly record: DesktopServerRuntimeRecord;
    };

export class DesktopServerOwnership extends Context.Service<
  DesktopServerOwnership,
  {
    /**
     * Read the T3 home's ownership record and classify its owner. Never
     * starts, stops or signals anything.
     */
    readonly inspect: Effect.Effect<DesktopServerOwner>;
    /**
     * The path of the persisted runtime record for this desktop's T3 home.
     */
    readonly runtimeStatePath: Effect.Effect<string>;
  }
>()("@t3tools/desktop/backend/DesktopServerOwnership") {}

const { logInfo: logOwnershipInfo, logWarning: logOwnershipWarning } =
  DesktopObservability.makeComponentLogger("desktop-server-ownership");

/**
 * Signal 0 delivers nothing; it only reports whether the pid exists. EPERM
 * means it exists but belongs to another user, which still counts as alive.
 */
const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const readRuntimeRecord = Effect.fn("desktop.serverOwnership.readRuntimeRecord")(function* (
  path: string,
): Effect.fn.Return<Option.Option<DesktopServerRuntimeRecord>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(path).pipe(
    Effect.matchEffect({
      // A record we cannot read tells us nothing; treat it as absent
      // rather than refusing to start on a guess.
      onFailure: () => Effect.succeed(Option.none<string>()),
      onSuccess: (contents) => Effect.succeed(Option.some(contents)),
    }),
  );
  if (Option.isNone(raw)) {
    return Option.none<DesktopServerRuntimeRecord>();
  }
  const trimmed = raw.value.trim();
  if (trimmed.length === 0) {
    return Option.none<DesktopServerRuntimeRecord>();
  }
  const decoded = yield* decodeServerRuntimeRecord(trimmed).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<DesktopServerRuntimeRecord>()),
  );
  return decoded;
});

/**
 * Probe the recorded server's environment descriptor. A server that owns the
 * home and answers this probe is healthy; one that owns it and does not
 * answer is stranded.
 */
const probeEnvironment = Effect.fn("desktop.serverOwnership.probeEnvironment")(function* (
  httpClient: HttpClient.HttpClient,
  origin: string,
): Effect.fn.Return<boolean> {
  const request = HttpClientRequest.get(`${origin}${ENVIRONMENT_DESCRIPTOR_PATH}`);
  // A server that is not answering is the normal case here, not a failure,
  // so the transport error and the timeout both read as "not serving".
  const outcome = yield* httpClient
    .execute(request)
    .pipe(Effect.timeoutOption(Duration.seconds(2)), Effect.result);
  if (outcome._tag === "Failure") {
    return false;
  }
  const response = outcome.success;
  if (Option.isNone(response)) {
    return false;
  }
  if (response.value.status !== 200) {
    return false;
  }
  return true;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;

  // The desktop's server writes its runtime record next to the ownership
  // lock, in the same userdata directory the server uses.
  const runtimeStatePath = environment.path.join(
    environment.baseDir,
    "userdata",
    "server-runtime.json",
  );

  const inspect = Effect.fn("desktop.serverOwnership.inspect")(function* () {
    const record = yield* readRuntimeRecord(runtimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    if (Option.isNone(record)) {
      return { _tag: "none" } as const;
    }

    const value = record.value;
    if (!isProcessAlive(value.pid)) {
      // The recorded server is gone. Its lock is released with it, so the
      // home is free.
      return { _tag: "none" } as const;
    }

    const healthy = yield* probeEnvironment(httpClient, value.origin);
    if (healthy) {
      yield* logOwnershipInfo("a server already owns this T3 home", {
        pid: value.pid,
        port: value.port,
        origin: value.origin,
      });
      return {
        _tag: "healthy",
        record: value,
        httpBaseUrl: new URL(value.origin),
      } as const;
    }

    // The owner is alive but not answering. A service-managed server is
    // expected to be supervised, and a user-started server is not ours to
    // touch. Only a server this desktop started is ours to recover.
    if (value.serviceManaged === true) {
      yield* logOwnershipWarning("a background service owns this T3 home and is not answering", {
        pid: value.pid,
      });
      return { _tag: "foreign", record: value } as const;
    }

    return { _tag: "stranded", record: value } as const;
  });

  return DesktopServerOwnership.of({
    inspect: inspect(),
    runtimeStatePath: Effect.succeed(runtimeStatePath),
  });
});

export const layer = Layer.effect(DesktopServerOwnership, make);
