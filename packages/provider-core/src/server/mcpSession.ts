import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * Set when the operator configured `T3CODE_MCP_STDIO_WRAPPER`. Providers that
   * can launch a stdio MCP server run this program as `t3-code` instead of
   * connecting to `endpoint`; see `t3McpStdioLaunch`.
   */
  readonly stdioWrapper?: McpStdioWrapper;
}

/** Absolute executable path plus fixed arguments, validated at server startup. */
export interface McpStdioWrapper {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Environment variables the stdio wrapper reads to reach the session endpoint. */
const T3_MCP_URL_ENV = "T3_MCP_URL";
const T3_MCP_AUTHORIZATION_ENV = "T3_MCP_AUTHORIZATION";

/**
 * The `t3-code` stdio server to launch, or undefined when the provider should
 * connect to the HTTP endpoint. The endpoint and Authorization header value go
 * in the wrapper's environment, never its arguments.
 */
export function t3McpStdioLaunch(
  config: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader" | "stdioWrapper">,
):
  | {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    }
  | undefined {
  if (config.stdioWrapper === undefined) return undefined;
  return {
    command: config.stdioWrapper.command,
    args: config.stdioWrapper.args,
    env: {
      [T3_MCP_URL_ENV]: config.endpoint,
      [T3_MCP_AUTHORIZATION_ENV]: config.authorizationHeader,
    },
  };
}

/**
 * For providers that can only reach `t3-code` over HTTP. With a wrapper
 * configured they run without T3's tools rather than bypass it.
 */
export function httpOnlyMcpSession(
  config: McpProviderSessionConfig | undefined,
): McpProviderSessionConfig | undefined {
  return config?.stdioWrapper === undefined ? config : undefined;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
