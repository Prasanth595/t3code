/**
 * The factory's machine config over HTTP: `GET` and `PUT /api/factory/config`. The factory API is
 * not part of the typed environment HTTP API (that is the point of the seam, see
 * factory/docs/design.md), so this is a plain `fetch` that carries the connection's credential
 * itself: the session cookie when there is no bearer token, `Authorization: Bearer` when there is.
 * A relay (DPoP) connection needs a signed proof per request, which the shared helper only issues
 * for the typed API groups, so it is reported as unsupported rather than sent unauthenticated.
 */
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

export interface ConfigError {
  readonly file: string;
  readonly field?: string;
  readonly message: string;
}

export interface RepoBlock {
  readonly repo: string;
  readonly path: string;
  readonly factory: {
    readonly instructors: ReadonlyArray<string>;
    readonly base: string;
    readonly provision: ReadonlyArray<string>;
    readonly gate: ReadonlyArray<string>;
    readonly required_checks: ReadonlyArray<string>;
    readonly limits: {
      readonly minutes: number;
      readonly gate_retries: number;
      readonly regates: number;
      readonly checks_minutes: number;
      readonly interruption_resumes: number;
    };
    readonly autonomy: string;
  } | null;
  readonly errors: ReadonlyArray<ConfigError> | null;
}

/** The seven keys the form edits, under the YAML field names. */
export interface MachineConfigValues {
  readonly gh_config_dir: string;
  readonly poll_seconds: number | null;
  readonly max_concurrent_runs: number | null;
  readonly max_concurrent_gates: number | null;
  readonly model_instance: string;
  readonly model: string;
  readonly repos: ReadonlyArray<{ readonly repo: string; readonly path: string }>;
}

export interface MachineConfigReport {
  readonly file: string;
  readonly exists: boolean;
  /** The file's values; the defaults when there is no file; null when the file does not load. */
  readonly config: {
    readonly gh_config_dir: string;
    readonly poll_seconds: number;
    readonly max_concurrent_runs: number;
    readonly max_concurrent_gates: number;
    readonly model_instance: string;
    readonly model: string;
    readonly repos: ReadonlyArray<{ readonly repo: string; readonly path: string }>;
  } | null;
  readonly errors: ReadonlyArray<ConfigError>;
  readonly repos: ReadonlyArray<RepoBlock>;
}

export type FactoryConfigResult =
  | { readonly kind: "ok"; readonly report: MachineConfigReport }
  | { readonly kind: "invalid"; readonly errors: ReadonlyArray<ConfigError> }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error"; readonly message: string };

const CONFIG_PATH = "/api/factory/config";

const request = async (
  prepared: PreparedConnection,
  method: "GET" | "PUT",
  body?: MachineConfigValues,
): Promise<FactoryConfigResult> => {
  const authorization = prepared.httpAuthorization;
  if (authorization?._tag === "Dpop") {
    return {
      kind: "error",
      message: "The factory settings are not available over a relay connection yet.",
    };
  }
  try {
    const response = await fetch(`${prepared.httpBaseUrl.replace(/\/+$/, "")}${CONFIG_PATH}`, {
      method,
      // A cookie session sends no header; a bearer token must not also send cookies.
      credentials: authorization === null ? "include" : "omit",
      headers: {
        accept: "application/json",
        ...(authorization === null ? {} : { authorization: `Bearer ${authorization.token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 403) return { kind: "forbidden" };
    if (response.status === 422) {
      const parsed = (await response.json()) as { errors?: ReadonlyArray<ConfigError> };
      return { kind: "invalid", errors: parsed.errors ?? [] };
    }
    if (!response.ok) {
      return { kind: "error", message: await failureMessage(response) };
    }
    return { kind: "ok", report: (await response.json()) as MachineConfigReport };
  } catch (cause) {
    return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
};

const failureMessage = async (response: Response) => {
  const fallback = `The factory answered ${response.status}.`;
  try {
    const parsed = (await response.json()) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : fallback;
  } catch {
    return fallback;
  }
};

export const fetchFactoryConfig = (prepared: PreparedConnection) => request(prepared, "GET");

export const saveFactoryConfig = (prepared: PreparedConnection, values: MachineConfigValues) =>
  request(prepared, "PUT", values);
