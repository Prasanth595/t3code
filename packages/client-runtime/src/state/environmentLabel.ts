import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

/** What an environment label needs to tell same-name environments apart. */
export interface EnvironmentLabelSubject {
  readonly environmentId: string;
  /** The shown name: the user's nickname, else the server-reported hostname. */
  readonly label: string;
  readonly displayUrl: string | null;
  /** Null until the client has the server's config. */
  readonly platformOs?: ExecutionEnvironmentPlatformOs | null;
  /** A desktop-local WSL backend, which reports "linux". */
  readonly wsl?: boolean;
}

const OS_NAMES: Record<ExecutionEnvironmentPlatformOs, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: null,
};

function osName(environment: EnvironmentLabelSubject): string | null {
  if (environment.wsl === true) return "WSL";
  return environment.platformOs ? OS_NAMES[environment.platformOs] : null;
}

/** "http://192.168.1.20:3773/" reads as "192.168.1.20:3773"; an SSH "user@host" stays as is. */
function hostPort(environment: EnvironmentLabelSubject): string | null {
  const displayUrl = environment.displayUrl?.trim();
  if (!displayUrl) return null;
  try {
    const host = new URL(displayUrl).host;
    if (host !== "") return host;
  } catch {
    // Not a URL, e.g. an SSH destination.
  }
  return displayUrl.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").replace(/\/+$/, "") || null;
}

function shortId(environment: EnvironmentLabelSubject): string {
  return environment.environmentId.slice(0, 8);
}

const SUFFIX_RULES = [osName, hostPort, shortId];

/**
 * The environment's name as menus and machine labels show it. A unique name
 * shows bare. Same-name environments get a suffix: the client's own
 * environment reads "this device"; the others take the first of OS, host:port,
 * or short id that tells all of them apart.
 */
export function environmentDisplayLabel(
  environment: EnvironmentLabelSubject,
  environments: readonly EnvironmentLabelSubject[],
  primaryEnvironmentId: string | null,
): string {
  const colliding = environments.filter(
    (other) =>
      other.label === environment.label && other.environmentId !== environment.environmentId,
  );
  if (colliding.length === 0) return environment.label;
  if (environment.environmentId === primaryEnvironmentId) {
    return `${environment.label} · this device`;
  }
  const group = [
    environment,
    ...colliding.filter((other) => other.environmentId !== primaryEnvironmentId),
  ];
  for (const rule of SUFFIX_RULES) {
    const suffixes = group.map(rule);
    if (suffixes.every((suffix) => suffix !== null) && new Set(suffixes).size === group.length) {
      return `${environment.label} · ${suffixes[0]}`;
    }
  }
  return `${environment.label} · ${shortId(environment)}`;
}

export const ENVIRONMENT_NICKNAME_MAX_LENGTH = 64;

export type EnvironmentNicknameValidation =
  | { readonly ok: true; readonly nickname: string }
  | { readonly ok: false; readonly reason: string };

/** A nickname is trimmed, and must be non-empty and at most 64 characters. */
export function validateEnvironmentNickname(input: string): EnvironmentNicknameValidation {
  const nickname = input.trim();
  if (nickname === "") return { ok: false, reason: "Enter a name." };
  if (nickname.length > ENVIRONMENT_NICKNAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: `Use ${ENVIRONMENT_NICKNAME_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, nickname };
}

/**
 * The nickname map with one environment's nickname set, or removed when
 * `nickname` is null so the server-reported name shows again.
 */
export function withEnvironmentNickname(
  nicknames: Readonly<Record<string, string>>,
  environmentId: string,
  nickname: string | null,
): Record<string, string> {
  const next: Record<string, string> = { ...nicknames };
  if (nickname === null) delete next[environmentId];
  else next[environmentId] = nickname;
  return next;
}
