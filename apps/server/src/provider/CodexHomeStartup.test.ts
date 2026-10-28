import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { isCodexAuthRefreshDue, openCodexHomeStartup } from "./CodexHomeStartup.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const NOW_MS = Date.UTC(2026, 9, 27);

const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const authJson = (input: {
  readonly authMode?: string | null;
  readonly apiKey?: string | null;
  readonly accessToken?: string | null;
  readonly lastRefreshMs?: number;
}) =>
  JSON.stringify({
    ...(input.authMode === null ? {} : { auth_mode: input.authMode ?? "chatgpt" }),
    OPENAI_API_KEY: input.apiKey ?? null,
    ...(input.accessToken === null
      ? {}
      : {
          tokens: {
            id_token: jwt({}),
            access_token: input.accessToken ?? jwt({}),
            refresh_token: "refresh",
            account_id: "account",
          },
        }),
    ...(input.lastRefreshMs === undefined
      ? {}
      : { last_refresh: DateTime.formatIso(DateTime.makeUnsafe(input.lastRefreshMs)) }),
  });

const expiringIn = (ms: number) => jwt({ exp: (NOW_MS + ms) / 1000 });

describe("isCodexAuthRefreshDue", () => {
  it.each([
    ["exp 20 minutes out", authJson({ accessToken: expiringIn(20 * MINUTE_MS) }), false],
    ["exp 14 minutes out", authJson({ accessToken: expiringIn(14 * MINUTE_MS) }), true],
    [
      "exp wins over an old last_refresh",
      authJson({ accessToken: expiringIn(DAY_MS), lastRefreshMs: NOW_MS - 30 * DAY_MS }),
      false,
    ],
    ["no exp, refreshed 7 days ago", authJson({ lastRefreshMs: NOW_MS - 7 * DAY_MS }), false],
    [
      "no exp, refreshed 8 days minus 5 minutes ago",
      authJson({ lastRefreshMs: NOW_MS - 8 * DAY_MS + 5 * MINUTE_MS }),
      true,
    ],
    [
      "API key mode",
      authJson({ authMode: "apikey", apiKey: "key", accessToken: expiringIn(MINUTE_MS) }),
      false,
    ],
    ["unreadable file", "{", false],
  ])("%s", (_name, json, due) => {
    expect(isCodexAuthRefreshDue(json, NOW_MS)).toBe(due);
  });
});

it.layer(NodeServices.layer)("openCodexHomeStartup", (it) => {
  it.effect("refreshes a due home through one of the app-servers opening on it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const authPath = path.join(yield* fileSystem.makeTempDirectoryScoped(), "auth.json");
      // TestClock starts at epoch 0, so exp is relative to 0.
      yield* fileSystem.writeFileString(authPath, authJson({ accessToken: jwt({ exp: 60 }) }));
      const refreshes = yield* Ref.make(0);
      const refresh = Ref.update(refreshes, (count) => count + 1).pipe(
        Effect.andThen(
          fileSystem.writeFileString(
            authPath,
            authJson({ accessToken: jwt({ exp: 10 * 86_400 }) }),
          ),
        ),
      );
      const openSession = Effect.scoped(
        openCodexHomeStartup(authPath).pipe(
          Effect.flatMap((startup) => startup.start({ initialize: Effect.void, refresh })),
        ),
      );

      yield* Effect.all([openSession, openSession, openSession], { concurrency: "unbounded" });

      expect(yield* Ref.get(refreshes)).toBe(1);
    }),
  );

  it.effect("does not refresh again while a timed-out refresh may still be running", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const authPath = path.join(yield* fileSystem.makeTempDirectoryScoped(), "auth.json");
      yield* fileSystem.writeFileString(authPath, authJson({ accessToken: jwt({ exp: 60 }) }));
      const attempts = yield* Ref.make(0);
      const firstStarted = yield* Deferred.make<void>();
      const hangingRefresh = Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(firstStarted, undefined)),
        Effect.andThen(Effect.never),
      );
      const openSession = Effect.scoped(
        openCodexHomeStartup(authPath).pipe(
          Effect.flatMap((startup) =>
            startup.start({ initialize: Effect.void, refresh: hangingRefresh }),
          ),
        ),
      );

      const first = yield* openSession.pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("15 seconds");
      yield* Fiber.join(first);
      yield* openSession;

      expect(yield* Ref.get(attempts)).toBe(1);
    }),
  );

  it.effect("frees the home for the next app-server when an open fails before start", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const authPath = path.join(yield* fileSystem.makeTempDirectoryScoped(), "auth.json");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const failed = yield* openCodexHomeStartup(authPath);
          yield* failed.abandon;
          // Still inside the failed open's scope: without abandon this waits for the home forever.
          const next = yield* openCodexHomeStartup(authPath);
          yield* next.start({ initialize: Effect.void, refresh: Effect.void });
        }),
      );
    }),
  );

  it.effect("initializes one app-server at a time on a home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const counts = yield* Ref.make({ active: 0, most: 0 });
      // A real file write keeps each start in flight long enough for others to overlap.
      const initialize = Ref.update(counts, ({ active, most }) => ({
        active: active + 1,
        most: Math.max(most, active + 1),
      })).pipe(
        Effect.andThen(fileSystem.writeFileString(path.join(home, "probe"), "start")),
        Effect.andThen(
          Ref.update(counts, (current) => ({ ...current, active: current.active - 1 })),
        ),
      );
      const openSession = Effect.scoped(
        openCodexHomeStartup(path.join(home, "auth.json")).pipe(
          Effect.flatMap((startup) => startup.start({ initialize, refresh: Effect.void })),
        ),
      );

      yield* Effect.all(
        Array.from({ length: 5 }, () => openSession),
        {
          concurrency: "unbounded",
        },
      );

      expect((yield* Ref.get(counts)).most).toBe(1);
    }),
  );
});
