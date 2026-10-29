import { ServerTailscaleStatus } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { formatTailscaleHealth, readTailscaleHealth } from "../environment/TailscaleHealth.ts";

const encodeStatusJson = Schema.encodeEffect(fromJsonStringPretty(ServerTailscaleStatus));

const tailscaleStatusCommand = Command.make("status", {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show this machine's Tailscale state and what to fix."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const status = yield* readTailscaleHealth;
      yield* Console.log(
        flags.json ? yield* encodeStatusJson(status) : formatTailscaleHealth(status),
      );
    }),
  ),
);

export const tailscaleCommand = Command.make("tailscale").pipe(
  Command.withDescription("Check Tailscale on this machine."),
  Command.withSubcommands([tailscaleStatusCommand]),
);
