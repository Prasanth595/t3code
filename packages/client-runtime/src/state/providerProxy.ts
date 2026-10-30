import { type ProviderProxyState, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

// Install and start take seconds to minutes; nothing else changes the state on its own.
const TRANSIENT_REFRESH_MS = 2_000;
const isSettledRuntime = (state: ProviderProxyState) =>
  state.runtime.status !== "installing" && state.runtime.status !== "starting";

export function createProviderProxyEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:provider-proxy:state",
    tag: WS_METHODS.providerProxyGetState,
    staleTimeMs: 5_000,
    refreshIntervalMs: TRANSIENT_REFRESH_MS,
    isFinal: isSettledRuntime,
  });
  // A sign-in finishes in the browser, so its status is read until it settles.
  const loginStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:provider-proxy:login-status",
    tag: WS_METHODS.providerProxyGetLoginStatus,
    staleTimeMs: 0,
    refreshIntervalMs: TRANSIENT_REFRESH_MS,
    isFinal: (status) => status.status !== "wait",
    onAnswer: ({ environmentId }, status, registry) =>
      status.status === "ok"
        ? Effect.sync(() => registry.refresh(state({ environmentId, input: {} })))
        : Effect.void,
  });
  return {
    state,
    loginStatus,
    startLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:start-login",
      tag: WS_METHODS.providerProxyStartLogin,
    }),
    completeLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:complete-login",
      tag: WS_METHODS.providerProxyCompleteLogin,
    }),
    setAccountDisabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:set-account-disabled",
      tag: WS_METHODS.providerProxySetAccountDisabled,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(state({ environmentId, input: {} }))),
    }),
    removeAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:remove-account",
      tag: WS_METHODS.providerProxyRemoveAccount,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(state({ environmentId, input: {} }))),
    }),
  };
}
