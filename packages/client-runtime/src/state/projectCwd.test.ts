import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectResolveCwdError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { EnvironmentRpcFailure, EnvironmentRpcInput } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

const ENVIRONMENT_ID = EnvironmentId.make("cwd-environment");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("cwd-other-environment");

interface CwdTarget {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.projectsResolveCwd>;
}

const makeHarness = Effect.fnUntraced(function* (
  resolve: (
    target: CwdTarget,
  ) => Effect.Effect<{ cwd: string }, EnvironmentRpcFailure<typeof WS_METHODS.projectsResolveCwd>>,
) {
  const requests: CwdTarget[] = [];
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  for (const environmentId of [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID]) {
    supervisors.set(environmentId, {
      target: { environmentId },
      state: yield* SubscriptionRef.make({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
      }),
      session: yield* SubscriptionRef.make(
        Option.some({
          client: {
            [WS_METHODS.projectsResolveCwd]: (input: CwdTarget["input"]) =>
              Effect.suspend(() => {
                const target = { environmentId, input };
                requests.push(target);
                return resolve(target);
              }),
          },
        } as unknown as RpcSession),
      ),
    } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  }
  const supervisorFor = (environmentId: EnvironmentId) => {
    const supervisor = supervisors.get(environmentId);
    if (!supervisor) throw new Error(`Unexpected environment: ${environmentId}`);
    return supervisor;
  };
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (environmentId, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisorFor(environmentId),
          ),
        followStream: (environmentId, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisorFor(environmentId),
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const { resolveCwd } = createProjectEnvironmentAtoms(runtime, {
    projectAtom: () => Atom.make(null),
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const read = (target: CwdTarget) =>
    AtomRegistry.getResult(registry, resolveCwd(target), { suspendOnWaiting: true });
  return { registry, resolveCwd, read, requests };
});

describe("project cwd resolution", () => {
  it.effect.each([
    { worktreePath: "/server/worktree", expected: "/server/worktree" },
    { worktreePath: null, expected: "/server/project/ios" },
    { worktreePath: undefined, expected: "/server/project/ios" },
  ])("preserves the legacy cwd on an old server: $worktreePath", ({ worktreePath, expected }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness(() =>
        Effect.die(`Unknown request tag: ${WS_METHODS.projectsResolveCwd}`),
      );
      const target = {
        environmentId: ENVIRONMENT_ID,
        input: {
          cwd: "/server/project/ios",
          ...(worktreePath === undefined ? {} : { worktreePath }),
        },
      };

      expect(yield* h.read(target)).toEqual({ cwd: expected });
      expect(h.requests).toEqual([target]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "another unsupported RPC",
      error: `Unknown request tag: ${WS_METHODS.projectsListEntries}`,
    },
    { name: "an unexpected defect", error: new Error("Could not inspect the checkout") },
  ])("propagates $name without using the legacy cwd", ({ error }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness(() => Effect.die(error));
      const result = yield* h
        .read({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/server/project/ios", worktreePath: "/server/worktree" },
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(error);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "filesystem resolution errors",
      error: new ProjectResolveCwdError({
        cwd: "/server/project/ios",
        worktreePath: "/server/worktree",
        cause: new Error("Permission denied while inspecting the checkout"),
      }),
    },
    {
      name: "authorization errors",
      error: new EnvironmentAuthorizationError({
        requiredScope: AuthFilesystemReadScope,
        message: "File access is not granted.",
      }),
    },
  ])("propagates $name without using the legacy cwd", ({ error }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness(() => Effect.fail(error));
      const result = yield* h
        .read({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/server/project/ios", worktreePath: "/server/worktree" },
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(error);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the server's checkout fallback when the project directory is unavailable", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(() => Effect.succeed({ cwd: "/server/worktree" }));
      const target = {
        environmentId: ENVIRONMENT_ID,
        input: { cwd: "/server/project/ios", worktreePath: "/server/worktree" },
      };

      expect(yield* h.read(target)).toEqual({ cwd: "/server/worktree" });
      expect(h.requests).toEqual([target]);
    }).pipe(Effect.scoped),
  );

  it.effect("resolves again when the project root changes under the same worktree", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(({ input }) => Effect.succeed({ cwd: input.cwd }));
      const previous = {
        environmentId: ENVIRONMENT_ID,
        input: { cwd: "/server/old-project", worktreePath: "/server/deleted-worktree" },
      };
      const current = {
        ...previous,
        input: { ...previous.input, cwd: "/server/new-project" },
      };
      h.registry.mount(h.resolveCwd(previous));

      expect(yield* h.read(previous)).toEqual({ cwd: "/server/old-project" });
      expect(yield* h.read(current)).toEqual({ cwd: "/server/new-project" });
      expect(h.requests).toEqual([previous, current]);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["worktree", "environment"] as const)(
    "keeps the selected cwd when a previous %s responds late",
    (change) =>
      Effect.gen(function* () {
        const previousStarted = yield* Deferred.make<void>();
        const currentStarted = yield* Deferred.make<void>();
        const previousResponse = yield* Deferred.make<{ cwd: string }>();
        const currentResponse = yield* Deferred.make<{ cwd: string }>();
        const previous: CwdTarget = {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/server/project", worktreePath: "/server/first-worktree" },
        };
        const current: CwdTarget =
          change === "environment"
            ? { ...previous, environmentId: OTHER_ENVIRONMENT_ID }
            : {
                ...previous,
                input: { ...previous.input, worktreePath: "/server/second-worktree" },
              };
        const h = yield* makeHarness((target) => {
          const isPrevious =
            target.environmentId === previous.environmentId &&
            target.input.worktreePath === previous.input.worktreePath;
          return Deferred.succeed(isPrevious ? previousStarted : currentStarted, undefined).pipe(
            Effect.andThen(Deferred.await(isPrevious ? previousResponse : currentResponse)),
          );
        });
        const selectedTarget = Atom.make(previous);
        const selectedCwd = Atom.make((get) => get(h.resolveCwd(get(selectedTarget))));
        const previousRead = yield* h.read(previous).pipe(Effect.forkChild);
        yield* Deferred.await(previousStarted);
        h.registry.mount(selectedCwd);

        h.registry.set(selectedTarget, current);
        yield* Deferred.await(currentStarted);
        expect(AsyncResult.isSuccess(h.registry.get(selectedCwd))).toBe(false);
        yield* Deferred.succeed(currentResponse, { cwd: "/server/current-directory" });
        expect(
          yield* AtomRegistry.getResult(h.registry, selectedCwd, { suspendOnWaiting: true }),
        ).toEqual({ cwd: "/server/current-directory" });

        yield* Deferred.succeed(previousResponse, { cwd: "/server/previous-directory" });
        expect(yield* Fiber.join(previousRead)).toEqual({ cwd: "/server/previous-directory" });
        expect(
          yield* AtomRegistry.getResult(h.registry, selectedCwd, { suspendOnWaiting: true }),
        ).toEqual({ cwd: "/server/current-directory" });
        expect(h.requests).toEqual([previous, current]);
      }).pipe(Effect.scoped),
  );
});
