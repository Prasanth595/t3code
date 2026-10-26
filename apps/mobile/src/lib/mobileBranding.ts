export type MobileStageLabel = "Beta" | "Dev";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  return "Beta";
}
