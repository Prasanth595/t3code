/**
 * The machine config as the settings page edits it: a report of the file and what the loop last
 * read of each repo's project config, and an edit that changes only the keys the form sends, so
 * the comments and the keys it does not know (`notify`) stay as written. The edited text is
 * checked with `parseMachineConfig`, the rules the factory itself loads the file by.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import { isMap, isSeq, parseDocument, YAMLMap } from "yaml";

import {
  DEFAULT_MAX_CONCURRENT_GATES,
  DEFAULT_MODEL_INSTANCE,
  DEFAULT_POLL_SECONDS,
  loadMachineConfig,
  parseMachineConfig,
  type ConfigError,
  type MachineConfig,
  type ProjectConfig,
  type RepoConfigReading,
} from "./config.ts";

/** A project config as the report shows it: the YAML field names. */
export interface ProjectBlock {
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
}

/** The editable part of the machine config, under the YAML field names. */
export interface MachineConfigFields {
  readonly gh_config_dir: string;
  readonly poll_seconds: number;
  readonly max_concurrent_runs: number;
  readonly max_concurrent_gates: number;
  readonly model_instance: string;
  readonly model: string;
  readonly repos: ReadonlyArray<{ readonly repo: string; readonly path: string }>;
}

export interface MachineConfigReport {
  readonly file: string;
  readonly exists: boolean;
  /** The file's values; the defaults when there is no file; null when the file does not load. */
  readonly config: MachineConfigFields | null;
  readonly errors: ReadonlyArray<ConfigError>;
  /** One per repo of the loaded config, with what the loop last read of its project config. */
  readonly repos: ReadonlyArray<{
    readonly repo: string;
    readonly path: string;
    readonly factory: ProjectBlock | null;
    readonly errors: ReadonlyArray<ConfigError> | null;
  }>;
}

const EDITABLE_KEYS = [
  "gh_config_dir",
  "poll_seconds",
  "max_concurrent_runs",
  "max_concurrent_gates",
  "model_instance",
  "model",
] as const;

/** `max_concurrent_runs` has no default in the file (it is required); the form starts at one. */
const FORM_MAX_CONCURRENT_RUNS = 1;

const defaults = (): MachineConfigFields => ({
  gh_config_dir: "",
  poll_seconds: DEFAULT_POLL_SECONDS,
  max_concurrent_runs: FORM_MAX_CONCURRENT_RUNS,
  max_concurrent_gates: DEFAULT_MAX_CONCURRENT_GATES,
  model_instance: DEFAULT_MODEL_INSTANCE,
  model: "",
  repos: [],
});

const fieldsOf = (machine: MachineConfig): MachineConfigFields => ({
  gh_config_dir: machine.ghConfigDir,
  poll_seconds: machine.pollSeconds,
  max_concurrent_runs: machine.maxConcurrentRuns,
  max_concurrent_gates: machine.maxConcurrentGates,
  model_instance: machine.modelInstance,
  model: machine.model,
  repos: machine.repos.map(({ repo, path }) => ({ repo, path })),
});

const projectBlock = (project: ProjectConfig): ProjectBlock => ({
  instructors: project.instructors,
  base: project.base,
  provision: project.provision,
  gate: project.gate,
  required_checks: project.requiredChecks,
  limits: {
    minutes: project.limits.minutes,
    gate_retries: project.limits.gateRetries,
    regates: project.limits.regates,
    checks_minutes: project.limits.checksMinutes,
    interruption_resumes: project.limits.interruptionResumes,
  },
  autonomy: project.autonomy,
});

/** The report of the machine config file, joined with the loop's last reading of each repo. */
export const readMachineConfigReport = (
  file: string,
  readings: ReadonlyMap<string, RepoConfigReading>,
): Effect.Effect<MachineConfigReport, never, FileSystem.FileSystem> =>
  Effect.map(Effect.result(loadMachineConfig(file)), (loaded): MachineConfigReport => {
    if (Result.isFailure(loaded)) {
      return { file, exists: true, config: null, errors: loaded.failure.errors, repos: [] };
    }
    if (Option.isNone(loaded.success)) {
      return { file, exists: false, config: defaults(), errors: [], repos: [] };
    }
    const machine = loaded.success.value;
    return {
      file,
      exists: true,
      config: fieldsOf(machine),
      errors: [],
      repos: machine.repos.map(({ repo, path }) => {
        const reading = readings.get(repo);
        return {
          repo,
          path,
          factory: reading?.kind === "ok" ? projectBlock(reading.project) : null,
          errors: reading?.kind === "errors" ? reading.errors : null,
        };
      }),
    };
  });

/** A request body the edit can read: a JSON object. */
export const isJsonObject = (body: unknown): body is Readonly<Record<string, unknown>> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

const REPO_FIELDS = ["repo", "path"] as const;

/**
 * Sets `repos` in place: an item the file already has keeps its node, and so its comments, and a
 * body item that is not an object goes in as it is, for the parser to report.
 */
const setRepos = (doc: ReturnType<typeof parseDocument>, root: YAMLMap, value: unknown) => {
  const existing = root.get("repos", true);
  if (!Array.isArray(value) || !isSeq(existing)) {
    root.set("repos", Array.isArray(value) ? value.map(repoItem) : value);
    return;
  }
  value.forEach((item, i) => {
    const node = existing.items[i];
    if (isMap(node) && isJsonObject(item)) {
      for (const field of REPO_FIELDS) {
        if (Object.hasOwn(item, field)) node.set(field, item[field]);
      }
    } else if (i < existing.items.length) {
      existing.items[i] = doc.createNode(repoItem(item));
    } else {
      existing.add(doc.createNode(repoItem(item)));
    }
  });
  existing.items.length = Math.min(existing.items.length, value.length);
};

const repoItem = (item: unknown): unknown => {
  if (!isJsonObject(item)) return item;
  const out: Record<string, unknown> = {};
  for (const field of REPO_FIELDS) {
    if (Object.hasOwn(item, field)) out[field] = item[field];
  }
  return out;
};

/**
 * The machine config text with the body's keys applied, or the errors `parseMachineConfig` finds
 * in it. Keys the body does not have, and every comment, stay as they were.
 */
export const editMachineConfig = (
  existingText: string | null,
  body: Readonly<Record<string, unknown>>,
  file = "config.yml",
): Result.Result<string, ReadonlyArray<ConfigError>> => {
  const doc = parseDocument(existingText ?? "", { intAsBigInt: true });
  if (doc.errors.length > 0) {
    return Result.fail([{ file, message: `not valid YAML: ${doc.errors[0]!.message}` }]);
  }
  const root = isMap(doc.contents) ? doc.contents : new YAMLMap(doc.schema);
  if (doc.contents !== root) doc.contents = root as typeof doc.contents;
  for (const key of EDITABLE_KEYS) {
    if (Object.hasOwn(body, key)) root.set(key, body[key]);
  }
  if (Object.hasOwn(body, "repos")) setRepos(doc, root, body["repos"]);
  const text = doc.toString();
  const parsed = parseMachineConfig(text, file);
  return Result.isSuccess(parsed) ? Result.succeed(text) : Result.fail(parsed.failure);
};

/**
 * Writes `text` to `file` whole: into a temp file beside it, then renamed over it, so a reader
 * (the loop's reload, the status report) never sees half a file. The temp file goes on failure.
 */
export const writeMachineConfig = (file: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const temp = `${file}.${(yield* Random.nextInt).toString(36)}.tmp`;
    yield* fs.writeFileString(temp, text).pipe(
      Effect.andThen(fs.rename(temp, file)),
      Effect.tapError(() => Effect.ignore(fs.remove(temp, { force: true }))),
    );
  });
