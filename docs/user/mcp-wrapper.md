# Route T3 tools through a wrapper

Set `T3CODE_MCP_STDIO_WRAPPER` in the environment that starts your T3 server to route its built-in MCP tools through a local stdio proxy. Install the proxy on the server machine, even if you connect from another device. Restart the server after changing the setting.

The value is an absolute executable path followed by fixed arguments. Quote paths or arguments containing spaces. T3 splits the value like provider launch arguments; it doesn't expand shell variables. On Windows, use a native executable or name an interpreter explicitly with the script path as an argument. A `.cmd` or `.bat` file may pass the executable check but fail to launch in a provider that doesn't use a shell.

Your wrapper must speak MCP over stdin/stdout and forward to the endpoint in `T3_MCP_URL`, using `T3_MCP_AUTHORIZATION` as the full Authorization header value. T3 supplies both values in the wrapper's environment, not its command-line arguments. Keep credentials and diagnostics off stdout, which carries MCP messages.

Codex, Claude, Cursor, managed OpenCode, OpenCode 2, and ACP providers receive the wrapper. Pi, Muse, and external OpenCode run without T3's tools. ACP's direct bridge and terminal fallback are disabled while the wrapper is configured. If OpenCode 2 can't register the wrapper, it logs a warning and runs without T3's tools; it doesn't retry over HTTP.

An empty or absent setting keeps the normal transport. A nonempty value with no command, a relative path, or a non-executable path stops server startup. Remove the setting and restart the server to return to the normal transport.

The wrapper routes T3's MCP traffic. It doesn't isolate an agent from the network or protect the endpoint from processes running as the same OS user. Enforcing network separation requires controls outside T3.
