import type { ServerProvider } from "@t3tools/contracts";

export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed && provider.status === "warning" && provider.auth.status === "unknown")
    return "checking";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

// T3 Code puts its bundled Pi on terminal PATH; sign-in happens with /login inside Pi.
export const PI_LOGIN_COMMAND = "pi";
