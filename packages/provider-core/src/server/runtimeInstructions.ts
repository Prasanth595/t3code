const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, use it for the owning thread: the MCP client's bound thread, or an owning threadId the caller supplied explicitly. Tool visibility does not identify a thread. Without a bound thread, pass that threadId to every link_pull_request, list_thread_pull_requests, watch_pull_request, and unwatch_pull_request call. Never guess a thread ID or use an unrelated thread. If no valid thread is known, or a call reports it missing or invalid, tell the user or parent once, return the PR URLs and unsettled state, and make no further calls that need it until you have a valid thread. Do not claim success.
With a valid thread and the tools available, register every PR you create or work on. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing one. For a stack, call it for every layer. Creating or updating PRs through gh, gh stack, another CLI, or the host API does not register them. Linking is idempotent. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing; skip PRs mentioned only as background. If linking fails, report the failure instead of claiming the PR is linked.
Watches belong to the eligible top-level thread. As a child or delegated task, do not call watch_pull_request, poll, or run a watcher, and do not target the parent thread to get around this; return the PR URLs, pushed head SHA, and unsettled review/check state to the parent. As the top-level owner with a valid non-child thread, when asked to monitor, watch, or babysit a PR, call watch_pull_request if available and end your turn instead of polling: T3 Code wakes the thread when checks finish, someone else comments, or the branch conflicts. Keep the watch while yielding for automatic continuation. When you hand responsibility back to the user, first call unwatch_pull_request for your watch so the thread returns to their inbox.
</pull_request_linking>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
