import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { callAcpMcpTool } from "../mcp/AcpMcpStdioBridge.ts";
import { listMcpTools, type McpToolEntry } from "../mcp/toolkits/registry.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { T3_TERMINAL_THREAD_ID_ENV } from "../terminal/terminalEnv.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class ToolCliError extends Schema.TaggedError<ToolCliError>()("ToolCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new ToolCliError({ detail }));

/** The parameter that every thread-bound MCP tool takes; omitted, it means the caller's thread. */
const THREAD_PARAMETER = "threadId";

const toolEnvironment = Config.all({
  endpoint: Config.String("T3_ACP_MCP_ENDPOINT").pipe(Config.option),
  authorization: Config.String("T3_ACP_MCP_AUTHORIZATION").pipe(Config.option),
  terminalThread: Config.String(T3_TERMINAL_THREAD_ID_ENV).pipe(Config.option),
});

export const findMcpTool = (name: string) => {
  const tool = listMcpTools().find((entry) => entry.name === name);
  return tool === undefined
    ? fail(`Unknown tool "${name}". Run \`t3 tool list\` to see the available tools.`)
    : Effect.succeed(tool);
};

const takesThread = (tool: McpToolEntry) => {
  const properties = tool.inputSchema.properties;
  return typeof properties === "object" && properties !== null && THREAD_PARAMETER in properties;
};

/**
 * Fills `threadId` for thread-bound tools. A caller with its own thread
 * credential (an agent terminal) may omit it; any other caller has no thread,
 * so the thread must come from `--thread` or the T3 terminal environment.
 */
export const applyCallerThread = (input: {
  readonly tool: McpToolEntry;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly thread: Option.Option<string>;
  readonly hasThreadCredential: boolean;
}) => {
  if (!takesThread(input.tool) || input.arguments[THREAD_PARAMETER] !== undefined) {
    return Effect.succeed(input.arguments);
  }
  if (Option.isSome(input.thread)) {
    return Effect.succeed({ ...input.arguments, [THREAD_PARAMETER]: input.thread.value });
  }
  return input.hasThreadCredential
    ? Effect.succeed(input.arguments)
    : fail(
        `Tool "${input.tool.name}" acts on a thread. Pass --thread <id>, set "${THREAD_PARAMETER}" in the input, or run it inside a T3 Code terminal.`,
      );
};

const decodeArguments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const readArguments = Effect.fn("readToolArguments")(function* (flags: {
  readonly input: Option.Option<string>;
  readonly inputFile: Option.Option<string>;
}) {
  if (Option.isSome(flags.input) && Option.isSome(flags.inputFile)) {
    return yield* fail("Pass --input or --input-file, not both.");
  }
  const fs = yield* FileSystem.FileSystem;
  const text = yield* Option.match(flags.inputFile, {
    onNone: () => Effect.succeed(Option.getOrElse(flags.input, () => "{}")),
    onSome: (path) =>
      fs
        .readFileString(path)
        .pipe(Effect.mapError(() => new ToolCliError({ detail: `Could not read ${path}.` }))),
  });
  return yield* decodeArguments(text).pipe(
    Effect.mapError(() => new ToolCliError({ detail: "Tool input must be a JSON object." })),
  );
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => Console.log(encodeJson(value));

/**
 * Calls one tool on the running server. An agent terminal reuses its thread
 * credential; otherwise the CLI issues a short-lived MCP client session from
 * the local auth store and revokes it after the call.
 */
export const callOnServer = Effect.fn("callToolOnServer")(function* (
  flags: { readonly baseDir: Option.Option<string> },
  run: (connection: {
    readonly endpoint: string;
    readonly authorization: string;
    readonly hasThreadCredential: boolean;
  }) => Effect.Effect<void, ToolCliError, FileSystem.FileSystem>,
) {
  const environment = yield* toolEnvironment;
  if (Option.isSome(environment.endpoint) && Option.isSome(environment.authorization)) {
    return yield* run({
      endpoint: environment.endpoint.value,
      authorization: environment.authorization.value,
      hasThreadCredential: true,
    });
  }
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return yield* fail("T3 Code server is not running. Start it, then run this again.");
  }
  const endpoint = new URL("/mcp", runtimeState.value.origin).toString();
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    yield* Effect.acquireUseRelease(
      auth.issueMcpClientSession({
        label: "t3 tool cli",
        // The CLI already holds the local auth store, so it gets the widest ceiling.
        access: "full-access",
        client: { deviceType: "bot" },
      }),
      (issued) =>
        run({ endpoint, authorization: `Bearer ${issued.token}`, hasThreadCredential: false }),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const toolListCommand = Command.make("list").pipe(
  Command.withDescription("List the MCP tools as JSON."),
  Command.withHandler(() =>
    printJson(listMcpTools().map(({ name, description }) => ({ name, description }))),
  ),
);

const toolDescribeCommand = Command.make("describe", {
  name: Argument.String("name").pipe(Argument.withDescription("Tool name.")),
}).pipe(
  Command.withDescription("Print a tool's description and input JSON schema."),
  Command.withHandler(({ name }) => findMcpTool(name).pipe(Effect.flatMap(printJson))),
);

const toolCallCommand = Command.make("call", {
  ...projectLocationFlags,
  name: Argument.String("name").pipe(Argument.withDescription("Tool name.")),
  input: Flag.String("input").pipe(
    Flag.withDescription("Tool input as a JSON object."),
    Flag.optional,
  ),
  inputFile: Flag.String("input-file").pipe(
    Flag.withDescription("Path to a file that holds the tool input as a JSON object."),
    Flag.optional,
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription(
      `Thread for thread-bound tools. Defaults to ${T3_TERMINAL_THREAD_ID_ENV} inside a T3 Code terminal.`,
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Call a tool on the running T3 Code server and print its result as JSON.",
  ),
  Command.withHandler(
    Effect.fn("toolCallCommand")(function* (flags) {
      const tool = yield* findMcpTool(flags.name);
      const parsed = yield* readArguments(flags);
      const environment = yield* toolEnvironment;
      const thread = Option.orElse(flags.thread, () => environment.terminalThread);
      yield* callOnServer(flags, (connection) =>
        Effect.gen(function* () {
          const toolArguments = yield* applyCallerThread({
            tool,
            arguments: parsed,
            thread,
            hasThreadCredential: connection.hasThreadCredential,
          });
          const result = yield* callAcpMcpTool({
            endpoint: connection.endpoint,
            authorization: connection.authorization,
            tool: tool.name,
            arguments: toolArguments,
          }).pipe(Effect.mapError((cause) => new ToolCliError({ detail: cause.message })));
          const envelope = (typeof result === "object" && result !== null ? result : {}) as {
            readonly isError?: unknown;
            readonly structuredContent?: unknown;
            readonly content?: unknown;
          };
          if (envelope.isError === true) {
            return yield* fail(
              `Tool "${tool.name}" failed: ${encodeJson(envelope.content ?? result)}`,
            );
          }
          yield* printJson(envelope.structuredContent ?? envelope.content ?? result);
        }),
      );
    }),
  ),
);

export const toolCommand = Command.make("tool").pipe(
  Command.withDescription("List, describe, and call T3 Code MCP tools."),
  Command.withSubcommands([toolListCommand, toolDescribeCommand, toolCallCommand]),
);
