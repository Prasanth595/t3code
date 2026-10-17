/**
 * The machine config as the settings page edits it: a report of the file and what the loop last
 * read of each repo's project config, and an edit that changes only the keys the form sends, so
 * the comments and the keys it does not know (`notify`) stay as written. The edited text is
 * checked with `parseMachineConfig`, the rules the factory itself loads the file by.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import { isMap, isScalar, isSeq, parseDocument, YAMLMap } from "yaml";

import {
  DEFAULT_MAX_CONCURRENT_GATES,
  DEFAULT_POLL_SECONDS,
  loadMachineConfig,
  parseMachineConfig,
  type ConfigError,
  type MachineConfig,
  type ProjectConfig,
  type RepoConfigReading,
} from "./config.ts";
import { writeFileAtomically } from "./t3/files.ts";

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
  readonly repos: ReadonlyArray<{ readonly repo: string; readonly path: string }>;
}

/** `MachineConfigFields` as a file that does not load holds them: any may be missing, and a repo may lack a part. */
export type MachineConfigDraft = Partial<Omit<MachineConfigFields, "repos">> & {
  readonly repos?: ReadonlyArray<{ readonly repo?: string; readonly path?: string }>;
};

/**
 * The report of the machine config file.
 * - `config`: the file's values; the defaults when there is no file; null when the file does not
 *   load.
 * - `defaults`: what a new file starts from, always present, so the form needs no copy of them.
 * - `draft`: present when the file exists and does not load. The values the file holds, read
 *   without validation so the form can show them and the person can fix one field instead of
 *   retyping the file. A top-level key of the form with a string value is copied as it is, a
 *   number as a number, `repos` as the items that are mappings (each with `repo` and `path` only
 *   when strings), and anything else is left out. A file that is not YAML has an empty draft.
 *   Values may be the wrong type for their field: the `errors` say which.
 */
export interface MachineConfigReport {
  readonly file: string;
  readonly exists: boolean;
  readonly config: MachineConfigFields | null;
  readonly defaults: MachineConfigFields;
  readonly draft?: MachineConfigDraft;
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
] as const;

/**
 * The keys of the machine config file: the form's, `repos`, and `notify`, which stays a hand edit.
 * A key that is not here is dropped by an edit, which is how the retired `model_instance` and
 * `model` (`RETIRED_MACHINE_KEYS` in `config.ts`) leave a file once it is saved from the page.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([...EDITABLE_KEYS, "repos", "notify"]);

/** `max_concurrent_runs` has no default in the file (it is required); the form starts at one. */
const FORM_MAX_CONCURRENT_RUNS = 1;

const defaults = (): MachineConfigFields => ({
  gh_config_dir: "",
  poll_seconds: DEFAULT_POLL_SECONDS,
  max_concurrent_runs: FORM_MAX_CONCURRENT_RUNS,
  max_concurrent_gates: DEFAULT_MAX_CONCURRENT_GATES,
  repos: [],
});

const fieldsOf = (machine: MachineConfig): MachineConfigFields => ({
  gh_config_dir: machine.ghConfigDir,
  poll_seconds: machine.pollSeconds,
  max_concurrent_runs: machine.maxConcurrentRuns,
  max_concurrent_gates: machine.maxConcurrentGates,
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

const scalarOf = (value: unknown): string | number | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "bigint"
      ? Number(value)
      : undefined;

/** The values of the form's keys in `text`, as written; see `MachineConfigReport.draft`. */
const draftOf = (text: string): MachineConfigDraft => {
  const doc = parseDocument(text, { intAsBigInt: true });
  if (doc.errors.length > 0) return {};
  const root: unknown = doc.toJS();
  if (!isJsonObject(root)) return {};
  const draft: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) {
    const value = scalarOf(root[key]);
    if (value !== undefined) draft[key] = value;
  }
  const repos = root["repos"];
  if (Array.isArray(repos)) {
    draft["repos"] = repos.filter(isJsonObject).map((item) => {
      const out: Record<string, string> = {};
      for (const field of REPO_FIELDS) {
        const value = item[field];
        if (typeof value === "string") out[field] = value;
      }
      return out;
    });
  }
  return draft;
};

/** The report of the machine config file, joined with the loop's last reading of each repo. */
export const readMachineConfigReport = (
  file: string,
  readings: ReadonlyMap<string, RepoConfigReading>,
): Effect.Effect<MachineConfigReport, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const loaded = yield* Effect.result(loadMachineConfig(file));
    if (Result.isFailure(loaded)) {
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      return {
        file,
        exists: true,
        config: null,
        defaults: defaults(),
        draft: draftOf(text),
        errors: loaded.failure.errors,
        repos: [],
      } satisfies MachineConfigReport;
    }
    if (Option.isNone(loaded.success)) {
      return {
        file,
        exists: false,
        config: defaults(),
        defaults: defaults(),
        errors: [],
        repos: [],
      } satisfies MachineConfigReport;
    }
    const machine = loaded.success.value.config;
    return {
      file,
      exists: true,
      config: fieldsOf(machine),
      defaults: defaults(),
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
    } satisfies MachineConfigReport;
  });

/** A request body the edit can read: a JSON object. */
export const isJsonObject = (body: unknown): body is Readonly<Record<string, unknown>> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

const REPO_FIELDS = ["repo", "path"] as const;

/**
 * Sets `repos`: a body item takes the node the file already has for that `repo`, with its
 * comments, and its `repo` and `path` are replaced as the body has them; any other item is a new
 * node. A node no item matched is dropped, and the sequence is in the body's order. An item that
 * is not an object goes in as it is, for the parser to report.
 */
const setRepos = (doc: ReturnType<typeof parseDocument>, root: YAMLMap, value: unknown) => {
  const existing = root.get("repos", true);
  if (!Array.isArray(value)) {
    root.set("repos", value);
    return;
  }
  const unmatched = isSeq(existing) ? [...existing.items] : [];
  const nodes = value.map((item): unknown => {
    const at = isJsonObject(item)
      ? unmatched.findIndex((node) => isMap(node) && node.get("repo") === item["repo"])
      : -1;
    if (at < 0 || !isJsonObject(item)) return doc.createNode(repoItem(item));
    const node = unmatched.splice(at, 1)[0] as YAMLMap;
    // A key the factory does not know (a typo) would keep the file invalid for good.
    node.items = node.items.filter((pair) => {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      return typeof key === "string" && (REPO_FIELDS as ReadonlyArray<string>).includes(key);
    });
    for (const field of REPO_FIELDS) {
      if (Object.hasOwn(item, field)) node.set(field, item[field]);
      else node.delete(field);
    }
    return node;
  });
  if (isSeq(existing)) existing.items = nodes as typeof existing.items;
  else root.set("repos", nodes);
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
 * in it. Keys the body does not have, and every comment, stay as they were; a key the factory
 * does not know is dropped, and a file that is not YAML is started again.
 */
export const editMachineConfig = (
  existingText: string | null,
  body: Readonly<Record<string, unknown>>,
  file = "config.yml",
): Result.Result<string, ReadonlyArray<ConfigError>> => {
  const parsedDoc = parseDocument(existingText ?? "", { intAsBigInt: true });
  // A file that is not YAML cannot keep its comments: the edit replaces it.
  const doc = parsedDoc.errors.length > 0 ? parseDocument("") : parsedDoc;
  const root = isMap(doc.contents) ? doc.contents : new YAMLMap(doc.schema);
  if (doc.contents !== root) doc.contents = root as typeof doc.contents;
  // Keys the form does not know and the parser rejects (a typo) would make the file invalid for good.
  root.items = root.items.filter((pair) => {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    return typeof key === "string" && KNOWN_KEYS.has(key);
  });
  for (const key of EDITABLE_KEYS) {
    if (Object.hasOwn(body, key)) root.set(key, body[key]);
  }
  if (Object.hasOwn(body, "repos")) setRepos(doc, root, body["repos"]);
  const text = doc.toString();
  const parsed = parseMachineConfig(text, file);
  return Result.isSuccess(parsed) ? Result.succeed(text) : Result.fail(parsed.failure);
};

/** What `saveMachineConfig` made of a request body. */
export type SaveResult =
  | { readonly kind: "ok"; readonly report: MachineConfigReport }
  | { readonly kind: "invalid"; readonly errors: ReadonlyArray<ConfigError> }
  | { readonly kind: "invalid-body" };

/** The file could not be read or written; the file is as it was or whole, never half written. */
export class SaveError extends Data.TaggedError("SaveError")<{ readonly cause: unknown }> {}

/**
 * Saves a request body into the machine config file: reads the file (none is an empty start),
 * applies the body (`editMachineConfig`), writes the text whole only when the parser accepts it,
 * then `reload`s the loop and reports the file as it is now. A body that is not a JSON object is
 * `invalid-body`, and an edit the parser refuses is `invalid`, with the file untouched.
 */
export const saveMachineConfig = (
  file: string,
  body: unknown,
  loop: {
    readonly reload: Effect.Effect<void>;
    readonly repoConfigs: Effect.Effect<ReadonlyMap<string, RepoConfigReading>>;
  },
): Effect.Effect<SaveResult, SaveError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (!isJsonObject(body)) return { kind: "invalid-body" } as const;
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs
      .readFileString(file)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
      );
    const edited = editMachineConfig(existing, body, file);
    if (Result.isFailure(edited)) return { kind: "invalid", errors: edited.failure } as const;
    yield* writeFileAtomically(file, edited.success);
    yield* loop.reload;
    const report = yield* readMachineConfigReport(file, yield* loop.repoConfigs);
    return { kind: "ok", report } as const;
  }).pipe(Effect.mapError((cause) => new SaveError({ cause })));
