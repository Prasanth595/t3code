import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

export interface ConfigError {
  readonly file: string;
  readonly field?: string;
  readonly message: string;
}

/** `<file>: <field>: <message>`, or `<file>: <message>` with no field. */
export const formatConfigError = (error: ConfigError): string =>
  error.field === undefined
    ? `${error.file}: ${error.message}`
    : `${error.file}: ${error.field}: ${error.message}`;

/** The typed failure of the loaders: every problem found in one file. */
export class ConfigErrors extends Schema.TaggedError<ConfigErrors>()("FactoryConfigErrors", {
  file: Schema.String,
  errors: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      field: Schema.optionalKey(Schema.String),
      message: Schema.String,
    }),
  ),
}) {
  override get message(): string {
    return this.errors.map(formatConfigError).join("\n");
  }
}

export interface Limits {
  readonly minutes: number;
  readonly gateRetries: number;
  readonly regates: number;
  readonly checksMinutes: number;
  readonly interruptionResumes: number;
}

export type Autonomy = "pr";

export interface ProjectConfig {
  readonly instructors: ReadonlyArray<string>;
  readonly base: string;
  readonly provision: ReadonlyArray<string>;
  readonly gate: ReadonlyArray<string>;
  readonly requiredChecks: ReadonlyArray<string>;
  readonly limits: Limits;
  readonly autonomy: Autonomy;
}

const DEFAULT_MINUTES = 180;
const DEFAULT_CHECKS_MINUTES = 30;
const DEFAULT_REGATES = 5;
const DEFAULT_INTERRUPTION_RESUMES = 2;
const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_MAX_CONCURRENT_GATES = 2;
const DEFAULT_MODEL_INSTANCE = "claudeAgent";

/** What a repo's runs are timed by when none of its project configs has loaded. */
export const timeLimitOnlyProjectConfig = (): ProjectConfig => ({
  instructors: [],
  base: "",
  provision: [],
  gate: [],
  requiredChecks: [],
  limits: {
    minutes: DEFAULT_MINUTES,
    gateRetries: 0,
    regates: DEFAULT_REGATES,
    checksMinutes: DEFAULT_CHECKS_MINUTES,
    interruptionResumes: DEFAULT_INTERRUPTION_RESUMES,
  },
  autonomy: "pr",
});

export const PROJECT_CONFIG_PATH = ".dw/config.yml";

export interface WatchedRepo {
  readonly repo: string;
  readonly path: string;
}

export interface MachineConfig {
  readonly ghConfigDir: string;
  readonly pollSeconds: number;
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentGates: number;
  readonly modelInstance: string;
  readonly model: string;
  readonly repos: ReadonlyArray<WatchedRepo>;
}

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

/**
 * Collects every problem of one file. A value of `undefined` stands for "no value": YAML never
 * produces it, so it marks an absent key or a parent that was already reported.
 */
const makeChecker = (file: string) => {
  const errors: Array<ConfigError> = [];

  const err = (field: string, message: string) => {
    errors.push(field === "" ? { file, message } : { file, field, message });
  };

  const child = (parent: Mapping | undefined, path: string, key: string): unknown => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) {
      err(join(path, key), "is missing");
      return undefined;
    }
    return parent[key];
  };

  const mapping = (value: unknown, path: string): Mapping | undefined => {
    if (value === undefined) return undefined;
    if (isMapping(value)) return value;
    err(path, "must be a mapping");
    return undefined;
  };

  const nonEmptyString = (value: unknown, path: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      err(path, "must be a string");
      return undefined;
    }
    if (value === "") {
      err(path, "must not be empty");
      return undefined;
    }
    return value;
  };

  /** An integer at or above `min`. YAML integers arrive as bigint, floats as number. */
  const uint = (value: unknown, path: string, min: number): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "bigint" && value >= BigInt(min)) return Number(value);
    if (typeof value === "bigint" || typeof value === "number") {
      err(path, `must be an integer of at least ${min}`);
      return undefined;
    }
    err(path, "must be an integer");
    return undefined;
  };

  /** Like `uint` for `key` under `parent`, but an absent key takes `fallback`. */
  const optionalUint = (
    parent: Mapping | undefined,
    path: string,
    key: string,
    fallback: number,
    min: number,
  ): number | undefined => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) return fallback;
    return uint(parent[key], join(path, key), min);
  };

  const optionalNonEmptyString = (
    parent: Mapping | undefined,
    path: string,
    key: string,
    fallback: string,
  ): string | undefined => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) return fallback;
    return nonEmptyString(parent[key], join(path, key));
  };

  const stringList = (
    value: unknown,
    path: string,
    allowEmpty: boolean,
  ): ReadonlyArray<string> | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      err(path, "must be a list of strings");
      return undefined;
    }
    if (value.length === 0 && !allowEmpty) {
      err(path, "must not be empty");
      return undefined;
    }
    const before = errors.length;
    const out: Array<string> = [];
    value.forEach((item, i) => {
      const text = nonEmptyString(item, `${path}[${i}]`);
      if (text !== undefined) out.push(text);
    });
    return errors.length === before ? out : undefined;
  };

  const autonomy = (value: unknown, path: string): Autonomy | undefined => {
    if (value === undefined) return undefined;
    if (value === "pr") return "pr";
    if (typeof value === "string") {
      err(path, `unsupported value \`${value}\`; only \`pr\` is accepted in phase 1`);
    } else {
      err(path, "must be a string; only `pr` is accepted in phase 1");
    }
    return undefined;
  };

  /** One file-level error per key of `value` that is not in `known`, in document order. */
  const unknownKeys = (value: Mapping, known: ReadonlyArray<string>, prefix: string) => {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) err("", `unknown key ${prefix}${key}`);
    }
  };

  /** Parse the text into a YAML mapping, or the single file-level error. */
  const root = (text: string): Result.Result<Mapping, ReadonlyArray<ConfigError>> => {
    let value: unknown;
    try {
      value = parse(text, { intAsBigInt: true });
    } catch (cause) {
      err("", `not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
      return Result.fail(errors);
    }
    if (!isMapping(value)) {
      err("", "top level must be a mapping");
      return Result.fail(errors);
    }
    return Result.succeed(value);
  };

  const finish = <T>(value: T | undefined): Result.Result<T, ReadonlyArray<ConfigError>> =>
    value !== undefined && errors.length === 0 ? Result.succeed(value) : Result.fail(errors);

  return {
    err,
    child,
    mapping,
    nonEmptyString,
    uint,
    optionalUint,
    optionalNonEmptyString,
    stringList,
    autonomy,
    unknownKeys,
    root,
    finish,
  };
};

type Checker = ReturnType<typeof makeChecker>;

const projectFrom = (c: Checker, root: Mapping): ProjectConfig | undefined => {
  const factory = c.mapping(c.child(root, "", "factory"), "factory");
  const instructors = c.stringList(
    c.child(factory, "factory", "instructors"),
    "factory.instructors",
    false,
  );
  const base = c.nonEmptyString(c.child(factory, "factory", "base"), "factory.base");
  const provision = c.stringList(
    c.child(factory, "factory", "provision"),
    "factory.provision",
    true,
  );
  const gate = c.stringList(c.child(factory, "factory", "gate"), "factory.gate", false);

  let requiredChecks: ReadonlyArray<string> | undefined;
  if (factory !== undefined) {
    if (Object.hasOwn(factory, "required_checks")) {
      requiredChecks = c.stringList(factory["required_checks"], "factory.required_checks", true);
      if (requiredChecks !== undefined && requiredChecks.length > 0) {
        c.err("factory.required_checks", "required_checks is not supported yet");
        requiredChecks = undefined;
      }
    } else {
      requiredChecks = [];
    }
  }

  const limits = c.mapping(c.child(factory, "factory", "limits"), "factory.limits");
  const minutes = c.optionalUint(limits, "factory.limits", "minutes", DEFAULT_MINUTES, 1);
  const gateRetries = c.uint(
    c.child(limits, "factory.limits", "gate_retries"),
    "factory.limits.gate_retries",
    0,
  );
  const regates = c.optionalUint(limits, "factory.limits", "regates", DEFAULT_REGATES, 1);
  const checksMinutes = c.optionalUint(
    limits,
    "factory.limits",
    "checks_minutes",
    DEFAULT_CHECKS_MINUTES,
    1,
  );
  const interruptionResumes = c.optionalUint(
    limits,
    "factory.limits",
    "interruption_resumes",
    DEFAULT_INTERRUPTION_RESUMES,
    0,
  );
  const autonomy = c.autonomy(c.child(factory, "factory", "autonomy"), "factory.autonomy");

  if (
    instructors === undefined ||
    base === undefined ||
    provision === undefined ||
    gate === undefined ||
    requiredChecks === undefined ||
    minutes === undefined ||
    gateRetries === undefined ||
    regates === undefined ||
    checksMinutes === undefined ||
    interruptionResumes === undefined ||
    autonomy === undefined
  ) {
    return undefined;
  }
  return {
    instructors,
    base,
    provision,
    gate,
    requiredChecks,
    limits: { minutes, gateRetries, regates, checksMinutes, interruptionResumes },
    autonomy,
  };
};

const MACHINE_KEYS = [
  "gh_config_dir",
  "poll_seconds",
  "max_concurrent_runs",
  "max_concurrent_gates",
  "model_instance",
  "model",
  "repos",
] as const;

const REPO_KEYS = ["repo", "path"] as const;

const reposFrom = (c: Checker, root: Mapping): ReadonlyArray<WatchedRepo> | undefined => {
  const value = c.child(root, "", "repos");
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    c.err("repos", "must be a list");
    return undefined;
  }
  if (value.length === 0) {
    c.err("repos", "must not be empty");
    return undefined;
  }
  const out: Array<WatchedRepo> = [];
  let ok = true;
  value.forEach((item, i) => {
    const at = `repos[${i}]`;
    const entry = c.mapping(item, at);
    const repo = c.nonEmptyString(c.child(entry, at, "repo"), `${at}.repo`);
    const path = c.nonEmptyString(c.child(entry, at, "path"), `${at}.path`);
    if (repo === undefined || path === undefined) ok = false;
    else out.push({ repo, path });
  });
  return ok ? out : undefined;
};

/** Unknown keys at any depth, after the known-field errors. Wrong-typed values are skipped. */
const checkUnknownKeys = (c: Checker, root: Mapping) => {
  c.unknownKeys(root, MACHINE_KEYS, "");
  const repos = root["repos"];
  if (!Array.isArray(repos)) return;
  repos.forEach((item, i) => {
    if (isMapping(item)) c.unknownKeys(item, REPO_KEYS, `repos[${i}].`);
  });
};

const machineFrom = (c: Checker, root: Mapping): MachineConfig | undefined => {
  const ghConfigDir = c.nonEmptyString(c.child(root, "", "gh_config_dir"), "gh_config_dir");
  const pollSeconds = c.optionalUint(root, "", "poll_seconds", DEFAULT_POLL_SECONDS, 10);
  const maxConcurrentRuns = c.uint(
    c.child(root, "", "max_concurrent_runs"),
    "max_concurrent_runs",
    1,
  );
  const maxConcurrentGates = c.optionalUint(
    root,
    "",
    "max_concurrent_gates",
    DEFAULT_MAX_CONCURRENT_GATES,
    1,
  );
  const modelInstance = c.optionalNonEmptyString(
    root,
    "",
    "model_instance",
    DEFAULT_MODEL_INSTANCE,
  );
  const model = c.nonEmptyString(c.child(root, "", "model"), "model");
  const repos = reposFrom(c, root);
  checkUnknownKeys(c, root);

  if (
    ghConfigDir === undefined ||
    pollSeconds === undefined ||
    maxConcurrentRuns === undefined ||
    maxConcurrentGates === undefined ||
    modelInstance === undefined ||
    model === undefined ||
    repos === undefined
  ) {
    return undefined;
  }
  return {
    ghConfigDir,
    pollSeconds,
    maxConcurrentRuns,
    maxConcurrentGates,
    modelInstance,
    model,
    repos,
  };
};

export const parseProjectConfig = (
  text: string,
  file: string,
): Result.Result<ProjectConfig, ReadonlyArray<ConfigError>> => {
  const c = makeChecker(file);
  const parsed = c.root(text);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  return c.finish(projectFrom(c, parsed.success));
};

export const parseMachineConfig = (
  text: string,
  file: string,
): Result.Result<MachineConfig, ReadonlyArray<ConfigError>> => {
  const c = makeChecker(file);
  const parsed = c.root(text);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  return c.finish(machineFrom(c, parsed.success));
};

const cannotRead = (file: string, cause: { readonly message: string }) =>
  new ConfigErrors({ file, errors: [{ file, message: `cannot read file: ${cause.message}` }] });

const toConfigErrors = <A>(
  file: string,
  parsed: Result.Result<A, ReadonlyArray<ConfigError>>,
): Effect.Effect<A, ConfigErrors> =>
  Result.isSuccess(parsed)
    ? Effect.succeed(parsed.success)
    : Effect.fail(new ConfigErrors({ file, errors: parsed.failure }));

/** Reads the file on every call. Nothing is cached. */
export const loadProjectConfig = (
  file: string,
): Effect.Effect<ProjectConfig, ConfigErrors, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((cause) => cannotRead(file, cause)));
    return yield* toConfigErrors(file, parseProjectConfig(text, file));
  });

/** Reads the file on every call. A file that does not exist is `Option.none()`. */
export const loadMachineConfig = (
  file: string,
): Effect.Effect<Option.Option<MachineConfig>, ConfigErrors, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(cannotRead(file, cause)),
      ),
    );
    if (Option.isNone(text)) return Option.none<MachineConfig>();
    return Option.some(yield* toConfigErrors(file, parseMachineConfig(text.value, file)));
  });
