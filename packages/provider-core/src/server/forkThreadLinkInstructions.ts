/**
 * Fork: the agent rule for thread links, one bullet of `T3_CODE_ORCHESTRATION_INSTRUCTIONS`. A
 * `t3-thread://` link resolves in the environment of its message, so a thread on another machine
 * or in text outside T3 Code needs its web address. Clients with the `threadLinkChips` setting
 * show both forms as the attached-thread chip.
 */
export const FORK_THREAD_LINK_INSTRUCTIONS = `- To mention a thread on this machine to the user, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded. T3 Code opens the thread in the app and shows its current title.
- For a thread on another machine, and in text that leaves T3 Code (GitHub, Slack, documents, web pages), link its web address \`[title](https://<host>/<environmentId>/<threadId>)\` instead. \`<host>\` is the address of the T3 server of the machine that has the thread, for example its hostname in \`machines_read\`. \`t3_environment_read\` on that machine gives its \`environmentId\`.
- An attached thread comes with a ready \`link\` line. Use it, not the \`[Thread: …]\` marker.`;
