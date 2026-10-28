import { WS_METHODS } from "@t3tools/contracts";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { Atom } from "effect/reactivity";

export function createRealtimeVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:realtime-voice:start",
      tag: WS_METHODS.realtimeVoiceStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:realtime-voice:stop",
      tag: WS_METHODS.realtimeVoiceStop,
    }),
  };
}
