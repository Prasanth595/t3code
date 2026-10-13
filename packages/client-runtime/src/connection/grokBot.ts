/** URL-only configuration leaves Grok Bot's connector to discover OAuth and request access. */
export function grokBotMcpSetup(mcpUrl: string) {
  return {
    configuration: JSON.stringify({ mcpServers: { t3: { url: mcpUrl } } }, null, 2),
    prompt: [
      `Connect T3 Code as a custom remote HTTPS MCP server named t3 at ${mcpUrl}.`,
      "Use OAuth discovery without bearer headers or static client credentials. Open its sign-in so I can approve access.",
      "After connecting, list the available T3 projects and coding providers, then stop.",
      "For future coding tasks, use T3's project and thread tools. Keep the returned thread ID, wait for the thread's results, and report its progress and results here.",
    ].join("\n\n"),
  };
}
