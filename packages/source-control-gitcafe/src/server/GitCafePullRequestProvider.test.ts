/**
 * Pins the requests `./GitCafePullRequestProvider.ts` sends for each operation this layer
 * supports. Pass 2 creates:
 *
 * - `./GitCafeApi.ts`: service `GitCafeApi` (key `"@t3tools/source-control-gitcafe/server/GitCafeApi"`)
 *   with `request({ host, operation, method?, path, body? }) => Effect<string, GitCafeApiError>`
 *   (the response body), sending `https://<host>/api<path>` with the `GitCafeCredentials` bearer
 *   token through `HttpClient`; `make` / `layer`. Refuses any host outside `GITCAFE_HOSTS`.
 *   `GitCafeApiError` carries the HTTP `status` so 401/429 map to unauthenticated/rate-limited.
 * - `./GitCafePullRequestProvider.ts`: `make: Effect<PullRequestProviderApi, never, GitCafeApi>`
 *   with kind `"gitcafe"`, implementing list, summary/detail, activity, diff, stack, comment,
 *   reply, resolve, review submit, synchronous merge, and stack land/restack fenced by
 *   `expectedStackHeads`.
 *
 * Every write carries a fresh `requestId`, which GitCafe requires.
 *
 * Out of scope here (layer 3): review-revision fencing, async outcome polling.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface SentRequest {
  readonly method: string;
  /** The path below `/api`, without its query. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly host: string;
  readonly body: unknown;
  /** The `redirect` mode FetchHttpClient would hand to fetch for this request. */
  readonly redirect: string | undefined;
}

/**
 * A GitCafe host answering `"METHOD /path"` (query stripped) from `routes`; anything else is a 404
 * problem document. Every request is recorded in order.
 */
function fakeGitCafe(
  routes: Record<string, unknown | ((request: SentRequest) => unknown)>,
  options: { readonly status?: number; readonly env?: NodeJS.ProcessEnv } = {},
) {
  const sent: Array<SentRequest> = [];
  const client = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest, _url, _signal, fiber) => {
      const url = new URL(request.url);
      assert.isTrue(url.pathname.startsWith("/api/"), url.pathname);
      assert.strictEqual(request.headers.authorization, "Bearer env-token");
      const entry: SentRequest = {
        method: request.method,
        path: url.pathname.slice("/api".length),
        query: url.searchParams,
        host: url.host,
        body:
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined,
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      };
      sent.push(entry);
      const route = routes[`${entry.method} ${entry.path}`];
      const response =
        route === undefined
          ? new Response(encodeJson({ type: "https://cafe.sh/errors/not-found" }), { status: 404 })
          : new Response(encodeJson(typeof route === "function" ? route(entry) : route), {
              status: options.status ?? 200,
            });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    },
  );
  const layer = GitCafeApi.layer.pipe(
    Layer.provide(GitCafeCredentials.layer),
    Layer.provide(TestSourceControlHost.layer()),
    // An environment token, so no test runs `cafe`.
    Layer.provide(
      Layer.succeed(HostProcess.Environment, options.env ?? { CAFE_TOKEN: "env-token" }),
    ),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  const writes = () =>
    sent.filter((request) => request.method !== "GET").map((r) => `${r.method} ${r.path}`);
  return { layer, sent, writes };
}

const target = { cwd: "/repo", host: "git.cafe", repository: "owner/repo", number: 7 };
const timestamp = "2026-09-12T12:00:00Z";
const headOid = "0123456789abcdef0123456789abcdef01234567";
const baseOid = "89abcdef0123456789abcdef0123456789abcdef";
const actor = {
  kind: "local",
  actorId: "act_one",
  handle: "alice",
  displayName: null,
  avatarUrl: "/avatars/one",
};
const pull = {
  id: "pr_one",
  number: 7,
  title: "Change",
  state: "open",
  draft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  headOid,
  observedBaseOid: baseOid,
  mergeRoute: "provider",
  author: actor,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 4,
  description: "Body",
  closedAt: null,
  mergedAt: null,
  sourceRepo: null,
  capabilities: { comment: true, review: true, merge: true, edit: true, moderate: true },
};
const root = {
  id: "root",
  threadId: "root",
  version: 2,
  author: actor,
  body: "Review",
  path: "file.ts",
  line: 3,
  side: "right",
  createdAt: timestamp,
  commitOid: headOid,
  resolvedAt: null,
  capabilities: {
    edit: true,
    hide: false,
    unhide: false,
    delete: false,
    resolve: true,
    unresolve: false,
  },
};
/**
 * GitCafe's stack route for pull 7, as it answers: members carry no heads, so each unmerged
 * layer's head comes from its own pull.
 */
const stack = (
  members: ReadonlyArray<{ number: number; headOid: string; state?: string }>,
): Record<string, unknown> => ({
  "GET /repos/owner/repo/pulls/7/stack": {
    stack: {
      id: "stack-one",
      number: 3,
      revision: 5,
      landingBase: "main",
      members: members.map((member, index) => ({
        pullRequestNumber: member.number,
        title: `Layer ${member.number}`,
        state: member.state ?? "open",
        draft: false,
        sourceBranch: `layer-${member.number}`,
        position: index + 1,
      })),
    },
  },
  ...Object.fromEntries(
    members.map((member) => [
      `GET /repos/owner/repo/pulls/${member.number}`,
      { ...pull, number: member.number, headOid: member.headOid },
    ]),
  ),
});

/** GitCafe refuses a write without an idempotency key. */
const assertRequestId = (body: unknown) =>
  assert.match(
    (body as { readonly requestId?: unknown } | undefined)?.requestId as string,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

describe("GitCafePullRequestProvider", () => {
  it.effect("lists a repository's pull requests from its pulls collection", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls": { items: [pull], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "alice",
        limit: 10,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [7],
      );
      assert.deepStrictEqual(
        server.sent.map((request) => `${request.method} ${request.path}`),
        ["GET /repos/owner/repo/pulls"],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("keeps a staging repository's requests and links on staging", () => {
    // CAFE_TOKEN follows CAFE_HOST, so staging reads the env token only when it is the target.
    const server = fakeGitCafe(
      { "GET /repos/owner/repo/pulls/7": pull },
      { env: { CAFE_TOKEN: "env-token", CAFE_HOST: "staging.git.cafe" } },
    );
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const summary = yield* provider.getChangeRequestSummary!({
        ...target,
        host: "staging.git.cafe",
      });
      assert.strictEqual(summary.url, "https://staging.git.cafe/owner/repo/pulls/7");
      assert.isTrue(server.sent.every((request) => request.host === "staging.git.cafe"));
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("refuses a repository outside GitCafe's hosts before sending anything", () => {
    const server = fakeGitCafe({});
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .getChangeRequest({ ...target, host: "github.com" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(server.sent, []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reports a refused token as unauthenticated and a limit as rate-limited", () =>
    Effect.gen(function* () {
      for (const [status, reason] of [
        [401, "unauthenticated"],
        [429, "rate-limited"],
      ] as const) {
        const server = fakeGitCafe(
          { "GET /repos/owner/repo/pulls/7/stack": { stack: null } },
          {
            status,
          },
        );
        const error = yield* GitCafePullRequestProvider.make.pipe(
          Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
          Effect.flip,
          Effect.provide(server.layer),
        );
        assert.strictEqual(error.reason, reason);
      }
    }),
  );

  it.effect("never lets fetch follow a redirect with the token", () => {
    const server = fakeGitCafe({ "GET /repos/owner/repo/pulls/7/stack": { stack: null } });
    return GitCafePullRequestProvider.make.pipe(
      Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
      Effect.tap(() =>
        Effect.sync(() =>
          assert.deepStrictEqual(
            server.sent.map((r) => r.redirect),
            ["manual"],
          ),
        ),
      ),
      Effect.provide(server.layer),
    );
  });

  it.effect("reads the stack a pull request belongs to, with each open layer's head", () => {
    const { "GET /repos/owner/repo/pulls/6": _merged, ...routes } = stack([
      { number: 6, headOid: baseOid, state: "merged" },
      { number: 7, headOid },
    ]);
    const server = fakeGitCafe(routes);
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider.getChangeRequestStack!(target);
      assert.strictEqual(result?.number, 3);
      // A merged layer is not fenced on, so its pull is never read.
      assert.deepStrictEqual(
        result?.layers.map((layer) => [layer.number, layer.headSha]),
        [
          [6, undefined],
          [7, headOid],
        ],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reads activity with the host's edit and resolve permissions", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/pulls/7/comments": { items: [root], next: null },
      "GET /repos/owner/repo/pulls/7/reviews": { items: [], next: null },
      "GET /repos/owner/repo/pulls/7/commits": {
        items: [],
        truncated: false,
        next: null,
        headOid,
      },
      "GET /repos/owner/repo/pulls/7/reactions/": { items: [], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const activity = yield* provider.getChangeRequestActivity(target);
      assert.strictEqual(activity.comments[0]?.canEdit, true);
      assert.strictEqual(activity.reviewThreads[0]?.canResolve, true);
      assert.deepStrictEqual(server.writes(), []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reads the viewer's permission to edit the pull request", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": {
        ...pull,
        capabilities: { ...pull.capabilities, edit: false },
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const permissions = yield* provider.getViewerPermissions(target);
      assert.strictEqual(permissions.editChangeRequest, false);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect(
    "refreshes preview, summary, detail and permissions during a pending authorized read",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let token: string | null = "old-token";
        const authorizations: Array<string | undefined> = [];
        const client = HttpClient.make((request) => {
          const authorization = request.headers.authorization;
          authorizations.push(authorization);
          const old = authorization === "Bearer old-token";
          const revoked = authorization === "Bearer revoked-token";
          return (
            old
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
          ).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  encodeJson(
                    revoked
                      ? { title: "Unauthorized" }
                      : new URL(request.url).pathname.endsWith("/status")
                        ? {
                            merge: {
                              conflicts: "unknown",
                              fastForward: true,
                              strategies: ["merge"],
                            },
                            checks: { pending: 0, failing: 0, total: 0 },
                          }
                        : {
                            ...pull,
                            headOid: null,
                            title: old ? "Old credentials" : "New credentials",
                            capabilities: { ...pull.capabilities, edit: !old },
                          },
                  ),
                  { status: revoked ? 401 : 200 },
                ),
              ),
            ),
          );
        });
        const provider = yield* GitCafePullRequestProvider.make.pipe(
          Effect.provide(
            GitCafeApi.layer.pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
              Layer.provide(
                Layer.succeed(GitCafeCredentials.GitCafeCredentials, {
                  get: (host) =>
                    Effect.suspend(() =>
                      token === null
                        ? Effect.fail(new GitCafeCredentials.GitCafeNotSignedInError({ host }))
                        : Effect.succeed({
                            host,
                            token: Redacted.make(token),
                            source: "settings" as const,
                          }),
                    ),
                  invalidate: () => Effect.void,
                  cliEnv: () => Effect.succeed({}),
                }),
              ),
            ),
          ),
        );
        const pending = yield* provider.getChangeRequestPreview!(target).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        token = "new-token";
        const refreshed = [
          yield* provider.getChangeRequestPreview!(target),
          yield* provider.getChangeRequestSummary!(target),
          yield* provider.getChangeRequest(target),
        ];
        assert.deepStrictEqual(
          refreshed.map((item) => item.title),
          ["New credentials", "New credentials", "New credentials"],
        );
        assert.strictEqual((yield* provider.getViewerPermissions(target)).editChangeRequest, true);
        for (let phase = 0; phase < 2; phase++) {
          token = phase === 0 ? null : "revoked-token";
          const rejected = [
            yield* provider.getChangeRequestPreview!(target).pipe(Effect.flip),
            yield* provider.getChangeRequestSummary!(target).pipe(Effect.flip),
            yield* provider.getChangeRequest(target).pipe(Effect.flip),
            yield* provider.getViewerPermissions(target).pipe(Effect.flip),
          ];
          assert.deepStrictEqual(
            rejected.map((error) => [error.operation, error.reason]),
            [
              ["getChangeRequestPreview", "unauthenticated"],
              ["getChangeRequestSummary", "unauthenticated"],
              ["getChangeRequest", "unauthenticated"],
              ["getViewerPermissions", "unauthenticated"],
            ],
          );
          if (phase === 0) {
            yield* Deferred.succeed(release, undefined);
            assert.strictEqual((yield* Fiber.join(pending)).title, "Old credentials");
          }
        }
        assert.deepStrictEqual(authorizations, [
          "Bearer old-token",
          ...Array.from({ length: 5 }, () => "Bearer new-token"),
          ...Array.from({ length: 4 }, () => "Bearer revoked-token"),
        ]);
      }),
  );

  it.effect.each([true, false])(
    "reads a fresh pull before and after a write succeeds: %s",
    (succeeds) => {
      let reads = 0;
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": () => ({
          ...pull,
          version: ++reads,
        }),
        ...(succeeds ? { "POST /repos/owner/repo/pulls/7/close": {} } : {}),
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        yield* provider.getChangeRequestPreview!(target);
        const result = yield* provider
          .runAction({ ...target, action: "close" })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, succeeds ? "Success" : "Failure");
        assert.deepStrictEqual(server.sent.at(-1)?.body, { expectedVersion: 2 });
        yield* provider.getChangeRequestPreview!(target);
        assert.strictEqual(reads, 3);
        assert.deepStrictEqual(
          server.sent.map((request) => `${request.method} ${request.path}`),
          [
            "GET /repos/owner/repo/pulls/7",
            "GET /repos/owner/repo/pulls/7",
            "POST /repos/owner/repo/pulls/7/close",
            "GET /repos/owner/repo/pulls/7",
          ],
        );
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("reads the diff from the pull request's changed files", () => {
    const file = {
      path: "file.ts",
      oldPath: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
    };
    const snapshot = { version: 4, headOid, comparisonBaseOid: baseOid };
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/pulls/7/changes": { ...snapshot, items: [file], next: null },
      "POST /repos/owner/repo/pulls/7/diff-files": {
        ...snapshot,
        items: [
          {
            ...file,
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [
                  { origin: "-", content: "old\n" },
                  { origin: "+", content: "new\n" },
                ],
              },
            ],
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const diff = yield* provider.getDiff(target);
      assert.include(diff.patch, "-old\n+new\n");
      assert.isNull(diff.nextCursor);
      // The batched hunk read is a POST, but it writes nothing.
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/7/diff-files"]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("comments and replies to a thread on the pull request's comments", () => {
    const written = { id: "c1", threadId: "root", version: 1 };
    const server = fakeGitCafe({
      "POST /repos/owner/repo/pulls/7/comments/": written,
      "POST /repos/owner/repo/pulls/7/comments/root/replies": written,
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.comment({ ...target, body: "Hello" });
      yield* provider.replyToThread({ ...target, threadId: "root", body: "Reply" });
      assert.deepStrictEqual(server.writes(), [
        "POST /repos/owner/repo/pulls/7/comments/",
        "POST /repos/owner/repo/pulls/7/comments/root/replies",
      ]);
      assert.deepStrictEqual(
        server.sent.map((request) => request.body),
        [{ body: "Hello" }, { body: "Reply" }],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("resolves a thread through its root at the root's version", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7/comments": { items: [root], next: null },
      "POST /repos/owner/repo/pulls/7/comments/root/resolve": {
        id: "root",
        threadId: "root",
        version: 3,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.setThreadResolution({ ...target, threadId: "root", resolved: true });
      assert.deepStrictEqual(server.writes(), [
        "POST /repos/owner/repo/pulls/7/comments/root/resolve",
      ]);
      assert.deepStrictEqual(server.sent.at(-1)?.body, { expectedVersion: 2 });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("submits a review against the pull request's current head", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "POST /repos/owner/repo/pulls/7/reviews": { id: "review-1" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.submitReview({
        ...target,
        verdict: "request-changes",
        body: "Please fix",
        comments: [],
      });
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/7/reviews"]);
      assert.deepInclude(server.sent.at(-1)?.body as object, {
        verdict: "request_changes",
        body: "Please fix",
        commitOid: headOid,
      });
      assertRequestId(server.sent.at(-1)?.body);

      // GitCafe rejects a null body; an empty review leaves it out.
      yield* provider.submitReview({ ...target, verdict: "approve", body: "", comments: [] });
      assert.notProperty(server.sent.at(-1)?.body as object, "body");
      assertRequestId(server.sent.at(-1)?.body);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    ["completed", true],
    ["failed", false],
  ] as const)("merges synchronously and reads a %s outcome", ([state, succeeds]) => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "POST /repos/owner/repo/pulls/7/merge": { id: "merge-1", state, reason: "Blocked" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .runAction({ ...target, action: "merge", mergeMethod: "squash" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, succeeds ? "Success" : "Failure");
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/7/merge"]);
      assert.deepInclude(server.sent.at(-1)?.body as object, {
        strategy: "squash",
        headOid,
        expectedVersion: 4,
      });
      assertRequestId(server.sent.at(-1)?.body);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect(
    "lands a stack through a layer only while its heads are the ones the reader saw",
    () => {
      const layers = [
        { number: 6, headOid: baseOid },
        { number: 7, headOid },
      ];
      const server = fakeGitCafe({
        ...stack(layers),
        "POST /repos/owner/repo/pulls/stacks/3/land-through": {
          id: "land-1",
          state: "completed",
          landedCount: 2,
          stepCount: 2,
          stopReason: null,
          error: null,
          steps: [],
        },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const heads = layers.map((layer) => ({ number: layer.number, headSha: layer.headOid }));
        const stale = yield* provider
          .runAction({
            ...target,
            action: "merge",
            stackNumber: 3,
            expectedStackHeads: [heads[0]!, { number: 7, headSha: baseOid }],
          })
          .pipe(Effect.result);
        assert.strictEqual(stale._tag, "Failure");
        assert.deepStrictEqual(server.writes(), []);

        yield* provider.runAction({
          ...target,
          action: "merge",
          stackNumber: 3,
          expectedStackHeads: heads,
          mergeMethod: "merge",
        });
        assert.deepStrictEqual(server.writes(), [
          "POST /repos/owner/repo/pulls/stacks/3/land-through",
        ]);
        assert.deepInclude(server.sent.at(-1)?.body as object, {
          expectedRevision: 5,
          throughPullRequestNumber: 7,
          strategy: "merge",
        });
        assertRequestId(server.sent.at(-1)?.body);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("restacks from a layer on update-branch", () => {
    const server = fakeGitCafe({
      ...stack([{ number: 7, headOid }]),
      "POST /repos/owner/repo/pulls/stacks/3/restack": {
        id: "restack-1",
        state: "completed",
        stepCount: 1,
        completedStepCount: 1,
        pauseReason: null,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.runAction({
        ...target,
        action: "update-branch",
        updateMethod: "rebase",
        stackNumber: 3,
        expectedStackHeads: [{ number: 7, headSha: headOid }],
      });
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/stacks/3/restack"]);
      const { requestId, ...body } = server.sent.at(-1)?.body as { requestId: unknown };
      assertRequestId({ requestId });
      assert.deepStrictEqual(body, { expectedRevision: 5 });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    ["authored", "authors"],
    ["reviewing", "reviewers"],
  ] as const)("filters %s pull requests by the viewer's actor on GitCafe", ([involvement, key]) => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/filter-options": {
        actors: [{ actorId: "act_one", handle: "Alice" }],
      },
      "GET /repos/owner/repo/pulls": { items: [pull], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement,
        viewer: "alice",
        limit: 10,
      });
      assert.strictEqual(server.sent.at(-1)?.query.get(key), '["act_one"]');
      assert.strictEqual(
        page.items[0]?.reviewRequestLogins.includes("alice"),
        involvement === "reviewing",
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("lists nothing for a viewer GitCafe has no actor for", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/filter-options": { actors: [] },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "authored",
        viewer: "alice",
        limit: 10,
      });
      assert.deepStrictEqual(page.items, []);
      assert.deepStrictEqual(
        server.sent.map((request) => request.path),
        ["/repos/owner/repo/filter-options"],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each(["authored", "reviewing"] as const)(
    "lists %s unnarrowed when GitCafe can't say who the viewer is",
    (involvement) => {
      // No `filter-options` route: the fake answers 404, which is an ordinary failure.
      const server = fakeGitCafe({ "GET /repos/owner/repo/pulls": { items: [pull], next: null } });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const page = yield* provider.listChangeRequests({
          ...target,
          state: "open",
          involvement,
          viewer: "alice",
          limit: 10,
        });
        const listing = server.sent.find((request) => request.path === "/repos/owner/repo/pulls");
        assert.isDefined(listing);
        assert.isNull(listing!.query.get(involvement === "reviewing" ? "reviewers" : "authors"));
        // An unnarrowed row says nothing about who was asked to review it.
        assert.notInclude(page.items[0]?.reviewRequestLogins ?? [], "alice");
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("reads line counts, open merge strategies and requested reviewers", () => {
    const snapshot = { version: 4, headOid, comparisonBaseOid: baseOid };
    const files = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ path: `f${from + index}.ts` }));
    let changePage = 0;
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": { ...pull, reviewers: [{ actor }] },
      "GET /repos/owner/repo/pulls/7/status": {
        merge: {
          conflicts: "unknown",
          fastForward: true,
          strategies: ["merge", "squash", "rebase"],
          blockers: [{ blockedStrategies: ["squash"] }, {}],
        },
        checks: { pending: 0, failing: 0, total: 0 },
      },
      // Checks continue on a cursor too; a failure on a later page must not be dropped.
      [`GET /repos/owner/repo/commits/${headOid}/checks`]: (request: SentRequest) => ({
        items: [
          {
            name: request.query.has("after") ? "late" : "early",
            status: "completed",
            conclusion: request.query.has("after") ? "failure" : "success",
            summary: null,
            detailsUrl: null,
          },
        ],
        next: request.query.has("after") ? null : "checks-1",
      }),
      // `/changes` counts no lines, and a pull past one page continues on a cursor.
      "GET /repos/owner/repo/pulls/7/changes": () =>
        changePage++ === 0
          ? { ...snapshot, items: files(0, 2), next: "cursor-1" }
          : { ...snapshot, items: files(2, 1), next: null },
      "POST /repos/owner/repo/pulls/7/diff-files": (request: SentRequest) => ({
        ...snapshot,
        items: (request.body as { paths: ReadonlyArray<string> }).paths.map((path) => ({
          path,
          additions: 2,
          deletions: 1,
        })),
      }),
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.deepInclude(detail, { additions: 6, deletions: 3, changedFiles: 3 });
      assert.strictEqual(
        server.sent.filter((request) => request.path.endsWith("/changes"))[1]?.query.get("after"),
        "cursor-1",
      );
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: true,
        squash: false,
        rebase: true,
      });
      assert.deepStrictEqual(
        detail.checks.map((check) => check.name),
        ["early", "late"],
      );
      // A requested reviewer shows before they have reviewed.
      assert.deepStrictEqual(
        detail.reviewers.map((reviewer) => reviewer.login),
        ["alice"],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each(["changes", "diff-files", "partial-changes", "partial-diff-files"] as const)(
    "retries line stats after a failed or incomplete %s read and retains the complete retry",
    (failedRead) => {
      const snapshot = { version: 4, headOid, comparisonBaseOid: baseOid };
      let recovered = false;
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": pull,
        "GET /repos/owner/repo/pulls/7/status": {
          merge: { conflicts: "unknown", fastForward: true, strategies: ["merge"] },
          checks: { pending: 0, failing: 0, total: 0 },
        },
        [`GET /repos/owner/repo/commits/${headOid}/checks`]: { items: [], next: null },
        "GET /repos/owner/repo/pulls/7/changes": () =>
          !recovered && failedRead === "changes"
            ? {}
            : {
                ...snapshot,
                items: [
                  failedRead === "partial-changes"
                    ? { path: "file.ts", additions: 5, ...(recovered ? { deletions: 2 } : {}) }
                    : { path: "file.ts" },
                  ...(failedRead === "partial-changes"
                    ? [{ path: "image.png", binary: true }]
                    : []),
                ],
                next: null,
              },
        "POST /repos/owner/repo/pulls/7/diff-files": () =>
          !recovered && failedRead === "diff-files"
            ? {}
            : {
                ...snapshot,
                items: [
                  {
                    path: "file.ts",
                    additions: 5,
                    ...(!recovered && failedRead === "partial-diff-files" ? {} : { deletions: 2 }),
                  },
                ],
              },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const firstReadStart = server.sent.length;
        assert.deepInclude(yield* provider.getChangeRequest(target), {
          additions: failedRead.startsWith("partial-") ? 5 : 0,
          deletions: 0,
          changedFiles: failedRead === "changes" ? 0 : failedRead === "partial-changes" ? 2 : 1,
        });
        assert.strictEqual(
          server.sent.length - firstReadStart,
          failedRead === "changes" || failedRead === "partial-changes" ? 4 : 5,
        );
        recovered = true;
        for (let read = 0; read < 2; read++) {
          const readStart = server.sent.length;
          assert.deepInclude(yield* provider.getChangeRequest(target), {
            additions: 5,
            deletions: 2,
            changedFiles: failedRead === "partial-changes" ? 2 : 1,
          });
          assert.strictEqual(
            server.sent.length - readStart,
            read === 1 ? 3 : failedRead === "partial-changes" ? 4 : 5,
          );
        }
        assert.strictEqual(
          server.sent.filter((request) => request.path.endsWith("/changes")).length,
          2,
        );
        assert.strictEqual(
          server.sent.filter((request) => request.path.endsWith("/diff-files")).length,
          failedRead === "partial-changes" ? 0 : failedRead === "changes" ? 1 : 2,
        );
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("retries line stats when a changes page leaves an unread cursor", () => {
    const snapshot = { version: 4, headOid, comparisonBaseOid: baseOid };
    let reads = 0;
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/pulls/7/status": {
        merge: { conflicts: "unknown", fastForward: true, strategies: ["merge"] },
        checks: { pending: 0, failing: 0, total: 0 },
      },
      [`GET /repos/owner/repo/commits/${headOid}/checks`]: { items: [], next: null },
      "GET /repos/owner/repo/pulls/7/changes": () =>
        reads++ === 0
          ? { ...snapshot, items: [], next: "unread" }
          : { ...snapshot, items: [{ path: "file.ts", additions: 5, deletions: 2 }], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      assert.deepInclude(yield* provider.getChangeRequest(target), {
        additions: 0,
        changedFiles: 0,
      });
      assert.deepInclude(yield* provider.getChangeRequest(target), {
        additions: 5,
        changedFiles: 1,
      });
      assert.strictEqual(reads, 2);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([baseOid, null])(
    "does not retain line stats for a comparison base different from %s",
    (observedBaseOid) => {
      let reads = 0;
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": { ...pull, observedBaseOid },
        "GET /repos/owner/repo/pulls/7/status": {
          merge: { conflicts: "unknown", fastForward: true, strategies: ["merge"] },
          checks: { pending: 0, failing: 0, total: 0 },
        },
        [`GET /repos/owner/repo/commits/${headOid}/checks`]: { items: [], next: null },
        "GET /repos/owner/repo/pulls/7/changes": () => ({
          version: 4,
          headOid,
          comparisonBaseOid: "another-base",
          items: [{ path: "file.ts", additions: ++reads, deletions: 0 }],
          next: null,
        }),
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        assert.strictEqual((yield* provider.getChangeRequest(target)).additions, 1);
        assert.strictEqual((yield* provider.getChangeRequest(target)).additions, 2);
        assert.strictEqual(reads, 2);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("fences a native merge on the target branch's current commit", () => {
    const branchOid = "fedcba9876543210fedcba9876543210fedcba98";
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": { ...pull, mergeRoute: "native", observedBaseOid: null },
      "GET /repos/owner/repo/commit": { oid: branchOid },
      "POST /repos/owner/repo/pulls/7/merge": { id: "merge-1", state: "completed" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.runAction({ ...target, action: "merge" });
      const branchRead = server.sent.find((request) => request.path === "/repos/owner/repo/commit");
      assert.strictEqual(branchRead?.query.get("ref"), "refs/heads/main");
      assert.deepInclude(server.sent.at(-1)?.body as object, { baseOid: branchOid, headOid });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("refuses to drop a reaction whose id it cannot address", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7/reactions/": {
        items: [
          {
            subject: { kind: "pull_request_comment", id: "root" },
            emoji: { kind: "unicode", value: "🚀" },
            count: 1,
            viewerReactionId: "../escape",
            reactors: [actor],
          },
        ],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .setReaction({ ...target, subjectId: "root", content: "rocket", reacted: false })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(server.writes(), []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("keeps GitCafe's explanation short and on one line", () => {
    const server = fakeGitCafe(
      {
        "GET /repos/owner/repo/pulls/7": { title: "Conflict", detail: `Line\n${"x".repeat(900)}` },
      },
      { status: 409 },
    );
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const error = yield* provider.getChangeRequest(target).pipe(Effect.flip);
      assert.notInclude(error.detail, "\n");
      assert.isAtMost(error.detail.length, 310);
      assert.isTrue(error.detail.startsWith("Line x"));
    }).pipe(Effect.provide(server.layer));
  });
});
