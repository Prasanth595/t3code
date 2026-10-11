import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { McpStdioWrapper } from "@t3tools/provider-core/server/mcpSession";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveCommandPath } from "@t3tools/shared/shell";

export const MCP_STDIO_WRAPPER_ENV = "T3CODE_MCP_STDIO_WRAPPER";

export class McpStdioWrapperConfigError extends Schema.TaggedError<McpStdioWrapperConfigError>()(
  "McpStdioWrapperConfigError",
  {
    reason: Schema.Literals(["empty", "relative", "notExecutable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "empty":
        return `${MCP_STDIO_WRAPPER_ENV} names no command.`;
      case "relative":
        return `${MCP_STDIO_WRAPPER_ENV} must start with an absolute path.`;
      case "notExecutable":
        return `${MCP_STDIO_WRAPPER_ENV} does not name an executable file.`;
    }
  }
}

/**
 * Splits `T3CODE_MCP_STDIO_WRAPPER` into an executable and fixed arguments the
 * way provider launch arguments are split, and checks the executable once so
 * a bad value stops startup instead of failing every provider session.
 */
export const resolveMcpStdioWrapper = Effect.fn("resolveMcpStdioWrapper")(function* (
  value: string,
) {
  const path = yield* Path.Path;
  const [command, ...args] = tokenizeCliArgs(value);
  if (command === undefined || command.length === 0) {
    return yield* new McpStdioWrapperConfigError({ reason: "empty" });
  }
  if (!path.isAbsolute(command)) {
    return yield* new McpStdioWrapperConfigError({ reason: "relative" });
  }
  const executable = yield* resolveCommandPath(command).pipe(
    Effect.catchTags({
      CommandResolutionError: (cause) =>
        Effect.fail(new McpStdioWrapperConfigError({ reason: "notExecutable", cause })),
    }),
  );
  return { command: executable, args } satisfies McpStdioWrapper;
});
