import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { factoryServerBearerToken, pairFactoryServer } from "./factoryServerIpc.ts";
import { layerDesktopEnvironment, layerSafeStorage } from "./testing.ts";

const accessTokenBody = (token: string) => ({
  access_token: token,
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "environment:connect",
});

const layerHttp = (
  requests: Array<{ readonly url: string; readonly body: string }>,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body;
        requests.push({
          url: request.url,
          body: body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, respond(request));
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

const withLayers = <A, E, R>(
  options: {
    readonly isPackaged?: boolean;
    readonly requests?: Array<{ readonly url: string; readonly body: string }>;
    readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Response;
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
          layerSafeStorage,
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
