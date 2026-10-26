const legacyFailures = {
  subscription_sharing_v2_user_not_eligible: {
    message:
      "ChatGPT sharing is unavailable for this account or workspace. Use another provider or check its sharing policy.",
  },
  subscription_sharing_usage_limit_exceeded: {
    message:
      "Your ChatGPT usage limit was reached. Check ChatGPT Usage settings for your available allowance.",
  },
  subscription_sharing_workplace_individual_usage_limit_exceeded: {
    message:
      "You reached your workspace's limit for using ChatGPT in other apps. Ask your workspace admin to increase it.",
  },
  subscription_sharing_usage_unavailable: {
    message: "ChatGPT usage is temporarily unavailable. Try again shortly.",
  },
  subscription_sharing_unsupported_capability: {
    message:
      "Codex used a feature that ChatGPT sharing does not support. Use another provider for this request.",
  },
  subscription_sharing_v2_client_not_enabled: {
    message:
      "This app is not enabled for this ChatGPT connection. Use your existing CLI or another provider.",
  },
  subscription_sharing_v2_route_not_supported: {
    message: "ChatGPT does not support this request route.",
  },
  subscription_sharing_v2_invalid_user: {
    message:
      "ChatGPT could not validate this connection. Check the selected account and sharing permissions.",
  },
  subscription_sharing_v2_user_unavailable: {
    message: "ChatGPT is temporarily unavailable. Try again shortly.",
  },
} as const;
const failures = {
  ...legacyFailures,
  subscription_sharing_user_not_eligible: legacyFailures.subscription_sharing_v2_user_not_eligible,
  subscription_sharing_route_not_supported:
    legacyFailures.subscription_sharing_v2_route_not_supported,
  subscription_sharing_invalid_user: legacyFailures.subscription_sharing_v2_invalid_user,
  subscription_sharing_user_unavailable: legacyFailures.subscription_sharing_v2_user_unavailable,
  chatpass_v2_scope_not_authorized: {
    message:
      "This ChatGPT grant does not authorize the request. Check the connection's sharing permissions.",
  },
  chatpass_v2_invalid_authorization_context: {
    message:
      "ChatGPT could not authorize this connection. Check the client and sharing permissions.",
  },
};
const usageLimitCodes = new Set<string>([
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_workplace_individual_usage_limit_exceeded",
]);
// Codex can stream only ChatGPT's prose for a sharing failure, without its code.
const proseCodes = [
  [
    "has reached their Subscription Sharing usage limit",
    "subscription_sharing_usage_limit_exceeded",
  ],
] as const;
export function classifyCodexManagedError(value: unknown) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof text !== "string") return undefined;
  const code =
    (Object.keys(failures) as Array<keyof typeof failures>).find((known) => text.includes(known)) ??
    proseCodes.find(([prose]) => text.includes(prose))?.[1];
  if (code === undefined) return undefined;
  const failure = { ...failures[code], code, usageLimit: usageLimitCodes.has(code) };
  if (code === "subscription_sharing_unsupported_capability") {
    if (text.includes("tool 'namespace'"))
      return {
        ...failure,
        message:
          "Codex sent a tool namespace that ChatGPT sharing does not support. Use another provider for this request.",
      };
    if (text.includes("additional_tools"))
      return {
        ...failure,
        message:
          "Codex sent an input item that ChatGPT sharing does not support. Use another provider for this request.",
      };
  }
  return failure;
}
