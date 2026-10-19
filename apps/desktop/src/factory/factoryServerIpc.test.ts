import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { EnvironmentAuthInvalidError, EnvironmentInternalError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { factoryServerBearerToken, pairFactoryServer } from "./factoryServerIpc.ts";
import { layerDesktopEnvironment, layerSafeStorageWith } from "./testing.ts";

const COULD_NOT_COMPLETE =
  "The factory server could not complete the pairing. Check its logs and try again.";

const accessTokenBody = (token: string) => ({
  access_token: token,
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "environment:connect",
});

/** A response, or the transport error of a server that could not be reached. */
type Respond = (
  request: HttpClientRequest.HttpClientRequest,
) => Response | HttpClientError.HttpClientError;

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

const rejected = () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
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

const unreachable = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) });

const withLayers = <A, E, R>(
  options: {
    readonly isPackaged?: boolean;
    readonly encryptionAvailable?: boolean;
    readonly requests?: Array<{ readonly url: string; readonly body: string }>;
    readonly respond?: Respond;
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
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

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
      { respond: rejected },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          pairFactoryServer.handler("http://127.0.0.1:3876/pair#token=stale"),
        );
        assert.equal(failureMessage(exit), "The factory server rejected this pairing link.");
        assert.equal(yield* factoryServerBearerToken, "");
      }),
    ),
  );

  it.effect("says the server rejected the link when it answers 401 auth_invalid", () =>
    withLayers(
      { respond: serverRejected },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), "The factory server rejected this pairing link.");
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

  it.effect("stores nothing when secure storage is unavailable", () =>
    withLayers(
      { encryptionAvailable: false },
      Effect.gen(function* () {
        const exit = yield* Effect.exit(pairFactoryServer.handler("abc123"));
        assert.equal(failureMessage(exit), "Could not store the factory server credential.");

        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        assert.isFalse(
          yield* fileSystem.exists(
            environment.path.join(environment.stateDir, "factory-server-credential.json"),
          ),
        );
        assert.equal(yield* factoryServerBearerToken, "");
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
