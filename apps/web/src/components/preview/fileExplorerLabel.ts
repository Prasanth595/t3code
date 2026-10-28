import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Arată în Finder";
  if (normalized.includes("win")) return "Arată în File Explorer";
  return "Arată în Fișiere";
}

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return "Arată în Finder";
  if (os === "windows") return "Arată în File Explorer";
  return "Arată în Fișiere";
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "Arată în Finder";
  if (kind === "file-explorer") return "Arată în File Explorer";
  return "Arată în Fișiere";
}
