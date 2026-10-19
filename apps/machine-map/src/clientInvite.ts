export const INVITE_FALLBACK =
  "Or copy the link, open the T3 app, open Environments, tap +, and paste it in Address.";

export const isPhone = (userAgent: string) => /Android|iPhone|iPad|Mobile/i.test(userAgent);

export const inviteAppUrl = (inviteUrl: string) =>
  `t3code-preview://connections/new?inviteUrl=${encodeURIComponent(inviteUrl)}`;

export function passkeyReturnUrl(url: URL) {
  const then = url.searchParams.get("then") ?? "";
  const resume = url.searchParams.get("resume") === "invite" ? "?resume=invite" : "";
  return new URL(`/${resume}${then.startsWith("#/") ? then : ""}`, url).href;
}
