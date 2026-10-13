/**
 * Fork: `t3 machine-map join <code> [--portal <url>]` (MM-203). It calls the tool
 * `machines_join` on the running server, so the CLI, the agent tool and T3 Settings share one
 * service method. The server must run.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "../../cli/config.ts";
import { ToolCliError, callOnServer } from "../../cli/tool.ts";
import { callAcpMcpTool } from "../../mcp/AcpMcpStdioBridge.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const joinCommand = Command.make("join", {
  ...projectLocationFlags,
  code: Argument.String("code").pipe(
    Argument.withDescription("The one-time join code from Add machine in the portal."),
  ),
  portal: Flag.String("portal").pipe(
    Flag.withDescription("Portal URL. Defaults to the portal of the machineMap setting."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Join this machine to the machine map with a one-time code."),
  Command.withHandler((flags) =>
    callOnServer(flags, (connection) =>
      Effect.gen(function* () {
        const result = yield* callAcpMcpTool({
          endpoint: connection.endpoint,
          authorization: connection.authorization,
          tool: "machines_join",
          arguments: {
            code: flags.code,
            ...(Option.isSome(flags.portal) ? { portalUrl: flags.portal.value } : {}),
          },
        }).pipe(Effect.mapError((cause) => new ToolCliError({ detail: cause.message })));
        const envelope = (typeof result === "object" && result !== null ? result : {}) as {
          readonly isError?: unknown;
          readonly content?: unknown;
        };
        if (envelope.isError === true) {
          return yield* new ToolCliError({
            detail: `Join failed: ${encodeJson(envelope.content ?? result)}`,
          });
        }
        yield* Console.log("Joined the machine map. The server connects to the portal now.");
      }),
    ),
  ),
);

export const machineMapCommand = Command.make("machine-map").pipe(
  Command.withDescription("Fork: the machine map of T3 servers (apps/machine-map/SPEC.md)."),
  Command.withSubcommands([joinCommand]),
);
