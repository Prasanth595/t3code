import { isHostedStaticApp } from "../hostedPairing";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

type EarlyPrimaryPath = "/api/auth/session" | "/.well-known/t3/environment";

declare global {
  interface Window {
    __t3EarlyPrimaryHttp?: {
      readonly origin: string;
      readonly responses: Partial<Record<EarlyPrimaryPath, Promise<unknown>>>;
    };
  }
}

export function canUseEarlyPrimaryHttp(): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge === undefined &&
    /^https?:$/.test(window.location.protocol) &&
    !isHostedStaticApp() &&
    new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin
  );
}

/** Bodies are read within the boot fetch deadline; failed speculation uses normal HTTP. */
export function takeEarlyPrimaryHttp(path: EarlyPrimaryPath): Promise<unknown> | undefined {
  if (typeof window === "undefined") return;
  const early = window.__t3EarlyPrimaryHttp;
  if (!early || early.origin !== window.location.origin || !canUseEarlyPrimaryHttp()) return;
  const response = early.responses[path];
  delete early.responses[path];
  return response;
}

export function discardEarlyPrimarySession(): void {
  if (typeof window === "undefined") return;
  if (window.__t3EarlyPrimaryHttp) {
    delete window.__t3EarlyPrimaryHttp.responses["/api/auth/session"];
  }
}
