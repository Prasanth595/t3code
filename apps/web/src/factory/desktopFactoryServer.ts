// In the packaged fork desktop app the primary environment is the factory's LaunchAgent
// server. Upstream's pairing exchange sets a cookie session, which cannot work from the
// desktop's custom-scheme origin to that server, so the desktop's main process exchanges the
// link for a bearer credential, stores it and the page reloads onto it.
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { FORK_FACTORY_SERVER_URL } from "@t3tools/shared/forkIdentity";

declare global {
  interface Window {
    readonly t3FactoryDesktop?: {
      readonly pairFactoryServer: (credential: string) => Promise<void>;
    };
  }
}

export function isFactoryServerPrimary(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.desktopBridge;
  if (!bridge) return false;
  const primary = bridge
    .getLocalEnvironmentBootstraps()
    .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  return primary?.httpBaseUrl === new URL(FORK_FACTORY_SERVER_URL).href;
}

/** True when the desktop took the credential; false leaves the pairing to upstream. */
export async function submitFactoryServerPairing(credential: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const factoryDesktop = window.t3FactoryDesktop;
  if (!factoryDesktop || !isFactoryServerPrimary()) return false;
  await factoryDesktop.pairFactoryServer(credential);
  window.location.reload();
  return true;
}
