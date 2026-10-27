import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentCatalogAtoms } from "./connections.ts";

const ENVIRONMENT_ID = EnvironmentId.make("catalog-environment");

const connectionState = (
  overrides: Partial<SupervisorConnectionState>,
): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  ...overrides,
});

describe("environment catalog atoms", () => {
  it.effect("changes the session generation only when a new session comes up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* SubscriptionRef.make(
          connectionState({ phase: "connected", attempt: 1, generation: 1 }),
        );
        const session = yield* SubscriptionRef.make(Option.some({} as RpcSession.RpcSession));
        const supervisor = {
          state,
          session,
        } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const registry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const catalog = createEnvironmentCatalogAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
        );
        const atom = catalog.sessionGenerationAtom(ENVIRONMENT_ID);
        const atoms = AtomRegistry.make();
        const unmount = atoms.mount(atom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unmount();
            atoms.dispose();
          }),
        );
        const lastFailure = new ConnectionTransientError({ reason: "transport", detail: "Down." });
        const generationAfter = (next: SupervisorConnectionState) =>
          SubscriptionRef.set(state, next).pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.map(() => atoms.get(atom)),
          );

        yield* Effect.yieldNow;
        expect(atoms.get(atom)).toBe(1);
        // A retry reports the generation it is attempting before it is established.
        expect(
          yield* generationAfter(
            connectionState({ phase: "connecting", stage: "opening", generation: 2, lastFailure }),
          ),
        ).toBe(1);
        expect(
          yield* generationAfter(
            connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
          ),
        ).toBe(1);
        expect(
          yield* generationAfter(
            connectionState({ phase: "connected", attempt: 2, generation: 2 }),
          ),
        ).toBe(2);
      }),
    ),
  );
});
