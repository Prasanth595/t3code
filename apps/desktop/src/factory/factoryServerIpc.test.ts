import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { factoryServerBearerToken, pairFactoryServer } from "./factoryServerIpc.ts";
import { accessTokenBody, layerDesktopEnvironment, layerSafeStorageWith } from "./testing.ts";

const COULD_NOT_COMPLETE =
  "The factory server could not complete the pairing. Check its logs and try again.";

const REJECTED = "The factory server rejected this pairing link.";

/** A response, the transport error of a server that could not be reached, or no answer at all. */
type Respond = (
  request: HttpClientRequest.HttpClientRequest,
) => Response | HttpClientError.HttpClientError | "hang";

const layerHttp = (
  requests: Array<{ readonly url: string; readonly body: string }>,
  respond: Respond,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const body = request.body;
        requests.push({
          url: request.url,
          body: body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "",
        });
        const result = respond(request);
        if (result === "hang") return Effect.never;
        return result instanceof Response
          ? Effect.succeed(HttpClientResponse.fromWeb(request, result))
          : Effect.fail(result);
      }),
    ),
  );

const accepted = (token: string) => () =>
  new Response(JSON.stringify(accessTokenBody(token)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const jsonResponse = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** What the real token endpoint answers for a pairing credential it does not accept. */
const serverRejected = jsonResponse(
  401,
  Schema.encodeSync(EnvironmentAuthInvalidError)(
    new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-1",
    }),
  ),
);

/** What the real token endpoint answers for an invalid request, such as an invalid scope. */
const serverBadRequest = jsonResponse(
  400,
  Schema.encodeSync(EnvironmentRequestInvalidError)(
    new EnvironmentRequestInvalidError({
      code: "invalid_request",
      reason: "invalid_scope",
      traceId: "trace-3",
    }),
  ),
);

const serverFailed = jsonResponse(
  500,
  Schema.encodeSync(EnvironmentInternalError)(
    new EnvironmentInternalError({
      code: "internal_error",
      reason: "access_token_issuance_failed",
      traceId: "trace-2",
    }),
  ),
);

/** A status the token endpoint does not declare, with a body that is not one of its errors. */
const undeclared = (status: number) => () => new Response("nope", { status });

const unreachable = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) });

const withLayers = <A, E, R>(
  options: {
    readonly isPackaged?: boolean;
    readonly encryptionAvailable?: boolean;
    readonly requests?: Array<{ readonly url: string; readonly body: string }>;
    readonly respond?: Respond;
    readonly logs?: Array<unknown>;
  },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-factory-credential-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          layerDesktopEnvironment(baseDir, options.isPackaged ?? true),
          layerSafeStorageWith({ encryptionAvailable: options.encryptionAvailable ?? true }),
          layerHttp(options.requests ?? [], options.respond ?? accepted("bearer-1")),
          Logger.layer([capturingLogger(options.logs ?? [])], { mergeWithExisting: false }),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** Keeps each log's message and annotations, the way the desktop log file receives them. */
const capturingLogger = (logs: Array<unknown>) =>
  Logger.make(({ message, fiber }) => {
    logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
  });

/** The logs as the console logger (`util.inspect`) and the OTLP logger (JSON) would write them. */
const logText = (logs: ReadonlyArray<unknown>): string =>
  `${NodeUtil.inspect(logs, { depth: null })}\n${JSON.stringify(logs)}`;

const failureMessage = <A, E>(exit: Exit.Exit<A, E>): string => {
  assert(Exit.isFailure(exit));
  const failure = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(failure));
  return (failure.value as { readonly message: string }).message;
};

describe("pairing the factory server", () => {
  it.effect("returns an empty token before pairing and null outside a packaged build", () =>
    Effect.gen(function* () {
      assert.equal(yield* withLayers({}, factoryServerBearerToken), "");
      assert.isNull(yield* withLayers({ isPackaged: false }, factoryServerBearerToken));
    }),
  );

  it.effect("exchanges a pairing link at 3876 and keeps the bearer encrypted", () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    return withLayers(
      { requests, respond: accepted("bearer-from-link") },
      Effect.gen(function* () {
        yield* pairFactoryServer.handler("http://127.0.0.1:3876/pair#token=abc123");

        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.url, "http://127.0.0.1:3876/oauth/token");
        assert.include(requests[0]?.body ?? "", "subject_token=abc123");
        assert.equal(yield* factoryServerBearerToken, "bearer-from-link");

        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const files = yield* fileSystem.readDirectory(environment.stateDir);
        const credentialFile = files.find((name) => name.includes("factory-server"));
        assert.isDefined(credentialFile);
        const raw = yield* fileSystem.readFileString(
          environment.path.join(environment.stateDir, credentialFile ?? ""),
        );
        assert.notInclude(raw, "bearer-from-link");
      }),
    );
  });

  it.effect("accepts a bare token", () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    return withLayers(
      { requests, respond: accepted("bearer-from-token") },
      Effect.gen(function* () {
        yield* pairFactoryServer.handler("  abc123  ");

        assert.include(requests[0]?.body ?? "", "subject_token=abc123");
        assert.equal(yield* factoryServerBearerToken, "bearer-from-token");
      }),
    );
  });

  it.effect("stores nothing and says so when the server rejects the link", () =>
    withLayers(
      { respond: serverRejected },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          pairFactoryServer.handler("http://127.0.0.1:3876/pair#token=stale"),
        );
        assert.equal(failureMessage(exit), REJECTED);
        assert.equal(yield* factoryServerBearerToken, "");
      }),
    ),
  );

  it.effect("does not call a 400 invalid request a rejected link", () =>
    withLayers(
      { respond: serverBadRequest },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), COULD_NOT_COMPLETE);
        assert.equal(yield* factoryServerBearerToken, "");
      }),
    ),
  );

  it.effect("says the server rejected the link when it answers 401 auth_invalid", () =>
    withLayers(
      { respond: serverRejected },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), REJECTED);
      }),
    ),
  );

  it.effect("does not call a server error a rejected link", () =>
    withLayers(
      { respond: serverFailed },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), COULD_NOT_COMPLETE);
        assert.equal(yield* factoryServerBearerToken, "");
      }),
    ),
  );

  it.effect("does not call an unreadable answer a rejected link", () =>
    withLayers(
      { respond: jsonResponse(200, { unexpected: true }) },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), COULD_NOT_COMPLETE);
      }),
    ),
  );

  it.effect("says the server is unreachable when the request cannot be sent", () =>
    withLayers(
      { respond: unreachable },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          pairFactoryServer.handler("http://127.0.0.1:3876/pair#token=abc"),
        );
        assert.equal(
          failureMessage(exit),
          "Could not reach the factory server at http://127.0.0.1:3876. Is it running?",
        );
        assert.equal(yield* factoryServerBearerToken, "");
      }),
    ),
  );

  it.effect("calls an undeclared 401 or 403 a rejected link and any other status not", () =>
    Effect.gen(function* () {
      for (const [status, reason] of [
        [401, REJECTED],
        [403, REJECTED],
        [502, COULD_NOT_COMPLETE],
      ] as const) {
        const exit = yield* withLayers(
          { respond: undeclared(status) },
          Effect.exit(pairFactoryServer.handler("abc123")),
        );
        assert.equal(failureMessage(exit), reason, `status ${status}`);
      }
    }),
  );

  it.effect("says the server is unreachable when it never answers", () =>
    withLayers(
      { respond: () => "hang" },
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.exit(pairFactoryServer.handler("abc123")));
        yield* TestClock.adjust("10 seconds");
        const exit = yield* Fiber.join(fiber);
        assert.equal(
          failureMessage(exit),
          "Could not reach the factory server at http://127.0.0.1:3876. Is it running?",
        );
      }),
    ),
  );

  it.effect("logs a failed pairing without the pairing credential", () =>
    Effect.gen(function* () {
      const credential = "secret-pairing-credential";
      for (const respond of [unreachable, serverRejected, undeclared(502)]) {
        const logs: Array<unknown> = [];
        yield* withLayers(
          { respond, logs },
          Effect.exit(pairFactoryServer.handler(`http://127.0.0.1:3876/pair#token=${credential}`)),
        );
        const text = logText(logs);
        assert.include(text, "factory server pairing failed");
        assert.notInclude(text, credential);
      }
    }),
  );

  it.effect("stores nothing and spends no link when secure storage is unavailable", () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    return withLayers(
      { encryptionAvailable: false, requests },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), "Could not store the factory server credential.");
        assert.equal(requests.length, 0);

        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        assert.isFalse(
          yield* fileSystem.exists(
            environment.path.join(environment.stateDir, "factory-server-credential.json"),
          ),
        );
        assert.equal(yield* factoryServerBearerToken, "");
      }),
    );
  });

  it.effect("leaves no temporary file behind when the credential cannot be saved", () =>
    withLayers(
      {},
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        // A non-empty directory where the credential file goes makes the rename fail.
        const credentialPath = environment.path.join(
          environment.stateDir,
          "factory-server-credential.json",
        );
        yield* fileSystem.makeDirectory(credentialPath, { recursive: true });
        yield* fileSystem.writeFileString(environment.path.join(credentialPath, "keep"), "");

        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), "Could not store the factory server credential.");
        const files = yield* fileSystem.readDirectory(environment.stateDir);
        assert.deepEqual(
          files.filter((name) => name.endsWith(".tmp")),
          [],
        );
      }),
    ),
  );

  it.effect("asks for a link when the input is empty", () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    return withLayers(
      { requests },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("   "));
        assert.equal(failureMessage(exit), "Paste a pairing link from `t3 pair`.");
        assert.equal(requests.length, 0);
      }),
    );
  });

  it.effect("refuses to pair outside a packaged build", () =>
    withLayers(
      { isPackaged: false },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert(Exit.isFailure(exit));
        assert.equal(yield* factoryServerBearerToken, null);
      }),
    ),
  );

  it.effect("treats an unreadable credential file as not paired", () =>
    withLayers(
      {},
      Effect.gen(function* () {
        yield* pairFactoryServer.handler("abc123");
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const [credentialFile] = (yield* fileSystem.readDirectory(environment.stateDir)).filter(
          (name) => name.includes("factory-server"),
        );
        yield* fileSystem.writeFileString(
          environment.path.join(environment.stateDir, credentialFile ?? ""),
          "not json",
        );
        assert.equal(yield* factoryServerBearerToken, "");
      }),
    ),
  );
});
