import type { EnvironmentId, MobileThreadCardLayout, ServerConfig } from "@t3tools/contracts";

/**
 * The mobile card layout from the first environment that has one. The setting
 * syncs to every environment, so they normally agree; null keeps the built-in card.
 */
export function firstMobileThreadCardLayout(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
): MobileThreadCardLayout | null {
  for (const config of configs.values()) {
    const layout = config.settings.threadCardLayouts.mobile;
    if (layout !== null) return layout;
  }
  return null;
}
