import type { ExecutionEnvironmentDescriptor, MachineDesiredState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../../serverSettings.ts";
import * as MachineMapState from "./MachineMapState.ts";

export function machineMapEnvironmentLabel(
  upstreamLabel: string,
  enabled: boolean,
  joined: boolean,
  desired: { readonly self: Pick<MachineDesiredState["self"], "name"> } | null,
) {
  const name = desired?.self.name.trim();
  return enabled && joined && name ? name : upstreamLabel;
}

export const withMachineMapLabel = (descriptor: Effect.Effect<ExecutionEnvironmentDescriptor>) =>
  Effect.gen(function* () {
    const map = yield* Effect.serviceOption(MachineMapState.MachineMapState);
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    if (Option.isNone(map) || Option.isNone(settings)) return descriptor;
    const state = map.value;
    const serverSettings = settings.value;
    return Effect.gen(function* () {
      const current = yield* descriptor;
      const enabled = yield* serverSettings.getSettings.pipe(
        Effect.map((value) => value.environmentLabelFromMachineMap),
        Effect.orElseSucceed(() => false),
      );
      const local = yield* state.snapshot;
      return {
        ...current,
        label: machineMapEnvironmentLabel(
          current.label,
          enabled,
          local.enabled && local.token !== null,
          local.saved.desired,
        ),
      };
    });
  });
