import type { ServerConfig } from "@t3tools/contracts";

import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";

export type ArtifactOpenAction = "external-browser" | "reveal";

export interface ArtifactOpenMenuItem {
  readonly action: ArtifactOpenAction;
  readonly label: string;
}

/**
 * The "Reveal in ..." wording for an artifact, or undefined when it cannot be
 * offered. Revealing runs on the environment host, so it only makes sense in
 * the desktop app talking to its own host, and only when the host can do it.
 */
export function artifactRevealLabel(input: {
  readonly isDesktop: boolean;
  readonly isPrimaryEnvironment: boolean;
  readonly serverConfig:
    | Pick<
        ServerConfig,
        | "availableEditors"
        | "environment"
        | "shellRevealInFileManager"
        | "shellRevealInFileManagerKind"
      >
    | null
    | undefined;
}): string | undefined {
  const config = input.serverConfig;
  if (!input.isDesktop || !input.isPrimaryEnvironment || config == null) return undefined;
  if (
    config.shellRevealInFileManager !== true ||
    !config.availableEditors.includes("file-manager")
  ) {
    return undefined;
  }
  return config.shellRevealInFileManagerKind === undefined
    ? revealInFileExplorerLabelForOs(config.environment.platform.os)
    : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind);
}

export function artifactOpenMenuItems(input: {
  readonly revealLabel: string | undefined;
}): ReadonlyArray<ArtifactOpenMenuItem> {
  return [
    { action: "external-browser", label: "External browser" },
    ...(input.revealLabel === undefined
      ? []
      : [{ action: "reveal", label: input.revealLabel } as const]),
  ];
}
