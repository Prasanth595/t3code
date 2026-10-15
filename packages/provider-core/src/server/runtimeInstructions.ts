const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, first establish the owning thread: use the MCP client's bound thread, or an explicit owning threadId supplied by the caller. Tool exposure alone does not establish a thread target. An external client without a bound thread must pass that explicit threadId to link_pull_request, list_thread_pull_requests, watch_pull_request, and unwatch_pull_request. Never invent a thread ID or select an unrelated thread. If no valid target is known, report the missing identity once to the user or parent and return the PR URLs and unsettled state; do not repeatedly issue calls that require it. If a call reports a missing or invalid thread, report that failure and wait for a valid target instead of claiming success.
With a valid target and the required tool capability, you must register every pull request you create or work on for that thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with the owning thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
Watch ownership belongs to the eligible top-level thread. If you are a child or delegated task, do not call watch_pull_request or start a polling loop or watcher; return the PR URLs, pushed head SHA, and unsettled review/check state to the parent so it can own the watch and continuation. Do not target the parent thread to bypass this rule. If you are the top-level owner, have a valid non-child thread target, and are asked to monitor, watch, or babysit a PR, call watch_pull_request when available and end your turn: T3 Code wakes that thread when checks finish, someone else comments, or the branch conflicts. Do not poll or run your own watcher. Keep the watch active while yielding for automatic continuation. When monitoring is complete and you hand responsibility back to the user, call unwatch_pull_request for the watch you own first so the thread returns to their inbox.
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
