import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "pingdotgg/t3code";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "Această instalare folosește arhitectura corectă.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "Acest Mac are Apple Silicon, dar Mira rulează versiunea Intel prin Rosetta. Descarcă actualizarea ca să treci la versiunea nativă Apple Silicon.";
  }
  if (action === "install") {
    return "Acest Mac are Apple Silicon, dar Mira rulează versiunea Intel prin Rosetta. Repornește ca să instalezi versiunea Apple Silicon descărcată.";
  }
  return "Acest Mac are Apple Silicon, dar Mira rulează versiunea Intel prin Rosetta. Următoarea actualizare o va înlocui cu versiunea nativă Apple Silicon.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return `Actualizarea ${state.notAppliedVersion} nu s-a aplicat. Apasă ca să reîncerci.`;
  }
  if (state.status === "available") {
    return `Actualizarea ${state.availableVersion ?? ""} e gata de descărcat`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Se descarcă actualizarea${progress}`;
  }
  if (state.status === "downloaded") {
    return `Actualizarea ${state.downloadedVersion ?? state.availableVersion ?? ""} a fost descărcată. Apasă ca să repornești și să instalezi.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Descărcarea ${state.availableVersion} a eșuat. Apasă ca să reîncerci.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Instalarea ${state.downloadedVersion} a eșuat. Apasă ca să reîncerci.`;
    }
    if (state.downloadedVersion) {
      return `Actualizarea ${state.downloadedVersion} a fost descărcată. Apasă ca să repornești și să instalezi.`;
    }
    return state.message ?? "Actualizarea a eșuat";
  }
  return "La zi";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Instalezi actualizarea${version ? ` ${version}` : ""} și repornești Mira?\n\nSarcinile în curs vor fi întrerupte. Asigură-te că ești pregătit înainte să continui.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
): string | null {
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Actualizările automate nu sunt disponibile în această versiune.";
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state);
  return disabledReason
    ? { title: "Actualizări indisponibile", detail: disabledReason }
    : { title: "Verifică actualizările", detail: null };
}
