// @effect-diagnostics nodeBuiltinImport:off -- Operator CLI boundary privately consumes the existing t3-peer Keychain helper and loopback HTTP API.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { AdmissionStatus } from "../orchestration-v2/Admission.ts";

const PeerConfig = Schema.Struct({
  runtime: Schema.String,
  credential_command: Schema.Array(Schema.String),
});
const Runtime = Schema.Struct({ origin: Schema.String });
const Credential = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Struct({
    token: Schema.String,
    expires_at: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
});

class AdmissionClientError extends Schema.TaggedError<AdmissionClientError>()(
  "AdmissionClientError",
  { reason: Schema.Literals(["config", "loopback_required", "credential", "request", "response"]) },
) {
  override get message(): string {
    return `Admission request failed (${this.reason}). Check the local t3-peer operator pairing and server; retry after correcting it.`;
  }
}

// Helper output is consumed only in memory. Errors deliberately discard raw
// stdout/stderr and child-process causes, which can contain the bearer token.
const readPrivateCredential = (executable: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      executable,
      args,
      {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout) =>
        error ? reject(new Error("credential consumer failed")) : resolve(stdout),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end('{"operation":"read"}');
  });

const requestAdmission = (operation: "status" | "drain" | "resume", configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* fs.readFileString(configPath).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PeerConfig))),
      Effect.mapError(() => new AdmissionClientError({ reason: "config" })),
    );
    const runtime = yield* fs.readFileString(config.runtime).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Runtime))),
      Effect.mapError(() => new AdmissionClientError({ reason: "config" })),
    );
    const origin = yield* Effect.try({
      try: () => new URL(runtime.origin),
      catch: () => new AdmissionClientError({ reason: "loopback_required" }),
    });
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return yield* new AdmissionClientError({ reason: "loopback_required" });
    }
    const [executable, ...args] = config.credential_command;
    if (!executable) return yield* new AdmissionClientError({ reason: "credential" });
    const credential = yield* Effect.tryPromise({
      try: () => readPrivateCredential(executable, args),
      catch: () => new AdmissionClientError({ reason: "credential" }),
    }).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Credential))),
      Effect.map((result) => result.value),
      Effect.mapError(() => new AdmissionClientError({ reason: "credential" })),
    );
    const now = yield* Clock.currentTimeMillis;
    if (
      !credential.token ||
      !Number.isFinite(Date.parse(credential.expires_at)) ||
      Date.parse(credential.expires_at) <= now ||
      !["orchestration:read", "orchestration:operate"].every((scope) =>
        credential.scopes.includes(scope),
      )
    ) {
      return yield* new AdmissionClientError({ reason: "credential" });
    }
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(operation === "status" ? "GET" : "POST")(
      new URL(`/api/local/admission/${operation}`, origin).toString(),
    ).pipe(HttpClientRequest.bearerToken(Redacted.make(credential.token)));
    return yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AdmissionStatus)),
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new AdmissionClientError({ reason: "request" })),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.withTracerEnabled(false));

const operationCommand = (operation: "status" | "drain" | "resume") =>
  Command.make(operation, {
    config: Flag.String("config").pipe(
      Flag.withDefault(
        NodePath.join(
          NodeOS.homedir(),
          "Library/Application Support/NoFunMesh/t3-peer/config.json",
        ),
      ),
      Flag.withDescription(
        "Local t3-peer config; privately uses its existing read+operate pairing and runtime metadata.",
      ),
    ),
  }).pipe(
    Command.withHandler(({ config }) =>
      requestAdmission(operation, config).pipe(
        Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(AdmissionStatus))),
        Effect.flatMap(Console.log),
      ),
    ),
  );

export const admissionCommand = Command.make("admission").pipe(
  Command.withDescription(
    "Drain, inspect, or resume local server turn admission using the t3-peer operator pairing.",
  ),
  Command.withSubcommands([
    operationCommand("drain"),
    operationCommand("status"),
    operationCommand("resume"),
  ]),
);
