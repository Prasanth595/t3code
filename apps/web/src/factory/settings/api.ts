/**
 * The factory's machine config over HTTP: `GET` and `PUT /api/factory/config`, sent on the given
 * connection by the factory's shared request helper (see `../http.ts`).
 */
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import { factoryRequest, failureMessage, parseJson } from "../http";

export interface ConfigError {
  readonly file: string;
  readonly field?: string;
  readonly message: string;
}

/** A watched T3 project with what the factory last read of its project config. */
export interface RepoBlock {
  /** The T3 project's title. */
  readonly title: string;
  /** `owner/name` of the project's GitHub repository. */
  readonly repo: string;
  /** The project's workspace root. */
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
    readonly autonomy: "pr";
  } | null;
  readonly errors: ReadonlyArray<ConfigError> | null;
}

/**
 * The four keys the form edits, under the YAML field names. The model is picked in T3, not here,
 * and so are the repos: the factory watches the T3 projects that opt in.
 */
export interface MachineConfigValues {
  readonly gh_config_dir: string;
  readonly poll_seconds: number | null;
  readonly max_concurrent_runs: number | null;
  readonly max_concurrent_gates: number | null;
}

/** The file's values read leniently when it does not load: any key may be missing or oddly typed. */
export type MachineConfigDraft = Partial<MachineConfigValues>;

export interface MachineConfigReport {
  readonly file: string;
  readonly exists: boolean;
  /** The file's values; the defaults when there is no file; null when the file does not load. */
  readonly config: {
    readonly gh_config_dir: string;
    readonly poll_seconds: number;
    readonly max_concurrent_runs: number;
    readonly max_concurrent_gates: number;
  } | null;
  /** What an empty form holds; the server owns these so the page never copies them. */
  readonly defaults: MachineConfigValues;
  /** Present when the file exists but does not load: its values, to edit instead of retype. */
  readonly draft?: MachineConfigDraft;
  readonly errors: ReadonlyArray<ConfigError>;
  /** The watched T3 projects, whatever the file holds. */
  readonly repos: ReadonlyArray<RepoBlock>;
  /** Workspace roots of projects the factory could not settle on its last read: neither watched nor gone. */
  readonly unresolved: ReadonlyArray<string>;
  /** Why the T3 projects could not be listed, else null; `repos` and `unresolved` are then empty. */
  readonly watch_error: string | null;
}

export type FactoryConfigResult =
  | { readonly kind: "ok"; readonly report: MachineConfigReport }
  | { readonly kind: "invalid"; readonly errors: ReadonlyArray<ConfigError> }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error"; readonly message: string };

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const CONFIG_PATH = "/api/factory/config";

const request = async (
  prepared: PreparedConnection,
  method: "GET" | "PUT",
  body?: MachineConfigValues,
): Promise<FactoryConfigResult> => {
  try {
    const response = await factoryRequest(prepared, { method, path: CONFIG_PATH, body });
    const parsed = parseJson(response.text);
    if (response.status === 403) return { kind: "forbidden" };
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 422 && isObject(parsed)) {
        const errors = (parsed as { errors?: ReadonlyArray<ConfigError> }).errors;
        return { kind: "invalid", errors: errors ?? [] };
      }
      return { kind: "error", message: failureMessage(response.status, parsed) };
    }
    if (!isObject(parsed)) {
      return { kind: "error", message: "The factory's answer was not JSON." };
    }
    return { kind: "ok", report: parsed as unknown as MachineConfigReport };
  } catch (cause) {
    return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
};

export const fetchFactoryConfig = (prepared: PreparedConnection) => request(prepared, "GET");

export const saveFactoryConfig = (prepared: PreparedConnection, values: MachineConfigValues) =>
  request(prepared, "PUT", values);
