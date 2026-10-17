import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

export const ConfigErrorSchema = Schema.Struct({
  file: Schema.String,
  field: Schema.optionalKey(Schema.String),
  message: Schema.String,
});
export type ConfigError = typeof ConfigErrorSchema.Type;

/** `<file>: <field>: <message>`, or `<file>: <message>` with no field. */
export const formatConfigError = (error: ConfigError): string =>
  error.field === undefined
    ? `${error.file}: ${error.message}`
    : `${error.file}: ${error.field}: ${error.message}`;

/** The typed failure of the loaders: every problem found in one file. */
export class ConfigErrors extends Schema.TaggedError<ConfigErrors>()("FactoryConfigErrors", {
  file: Schema.String,
  errors: Schema.Array(ConfigErrorSchema),
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
export const DEFAULT_POLL_SECONDS = 60;
export const DEFAULT_MAX_CONCURRENT_GATES = 2;

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

/** What the last pass found when it read a repo's project config. */
export type RepoConfigReading =
  | { readonly kind: "ok"; readonly project: ProjectConfig }
  | { readonly kind: "errors"; readonly errors: ReadonlyArray<ConfigError> };

export interface WatchedRepo {
  readonly repo: string;
  readonly path: string;
}

/** A watched repo with the title of the T3 project it comes from, for the settings page. */
export interface WatchedProject extends WatchedRepo {
  readonly title: string;
}

/** What the reader found: the watched projects, and the opted-in checkouts it could not identify this time. */
export interface WatchedListing {
  /** The projects that opted in and resolved to a GitHub `owner/name`, in T3's order. A repo two projects name appears once per project. */
  readonly repos: ReadonlyArray<WatchedProject>;
  /** Workspace roots of projects whose `.dw/config.yml` could not be read for a reason other than its absence, or that opted in but whose checkout T3 could not identify (a null identity). They are skipped; the list may be short. */
  readonly unresolved: ReadonlyArray<string>;
}

export interface MachineConfig {
  readonly ghConfigDir: string;
  readonly pollSeconds: number;
  /**
   * Runs that may hold a slot at once, counted over every repo: a run holds one from its claim
   * until its session reports its pull request or the run ends; the gate and the wait for the
   * required checks take no run slot. A session launched again for a `pr-open` run (a failed
   * re-gate) is not held back by it: the run holds a slot again from that launch and the next
   * claim counts it, so such relaunches can take the machine past the limit.
   */
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentGates: number;
  /** Whether a new attention item posts a macOS notification. The list is kept either way. */
  readonly notify: boolean;
}

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

/**
 * A machine config as it loaded: the config, and one warning per key the file still has that
 * the factory no longer reads. A warning never stops the load.
 */
export interface LoadedMachineConfig {
  readonly config: MachineConfig;
  readonly warnings: ReadonlyArray<ConfigError>;
}

/**
 * Collects every problem of one file. A value of `undefined` stands for "no value": YAML never
 * produces it, so it marks an absent key or a parent that was already reported.
 */
const makeChecker = (file: string) => {
  const errors: Array<ConfigError> = [];
  const warnings: Array<ConfigError> = [];

  const err = (field: string, message: string) => {
    errors.push(field === "" ? { file, message } : { file, field, message });
  };

  const warn = (field: string, message: string) => {
    warnings.push({ file, field, message });
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

  /** A boolean under `key` of `parent`; an absent key takes `fallback`. */
  const optionalBoolean = (
    parent: Mapping | undefined,
    path: string,
    key: string,
    fallback: boolean,
  ): boolean | undefined => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) return fallback;
    const value = parent[key];
    if (typeof value === "boolean") return value;
    err(join(path, key), "must be true or false");
    return undefined;
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
    warn,
    warnings,
    child,
    mapping,
    nonEmptyString,
    uint,
    optionalUint,
    optionalNonEmptyString,
    optionalBoolean,
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
  "notify",
] as const;

/**
 * Keys the factory read before and reads no more. #93 retired the model keys: the model comes
 * from the T3 project's default, then the T3 settings default. #106 retired `repos`: the factory
 * watches the T3 projects of its environment. A file written before the change still loads, with
 * a warning per key, so the factory that builds the upgrade keeps running, and a save from the
 * settings page keeps them (`settings.ts`) so a rollback to a version that requires them still
 * loads. Remove them from the file by hand once no rollback is possible.
 */
export const RETIRED_MACHINE_KEYS = ["model_instance", "model", "repos"] as const;

const RETIRED_KEY_MESSAGES: Record<(typeof RETIRED_MACHINE_KEYS)[number], string> = {
  model_instance:
    "is no longer used: the model comes from the T3 project's default model, then the T3 settings default",
  model:
    "is no longer used: the model comes from the T3 project's default model, then the T3 settings default",
  repos:
    "is no longer used: the factory watches the T3 projects of this environment whose checkout has a .dw/config.yml with a factory block",
};

/** Unknown keys at the top level, after the known-field errors; a retired key is a warning. */
const checkUnknownKeys = (c: Checker, root: Mapping) => {
  for (const key of RETIRED_MACHINE_KEYS) {
    if (Object.hasOwn(root, key)) c.warn(key, RETIRED_KEY_MESSAGES[key]);
  }
  c.unknownKeys(root, [...MACHINE_KEYS, ...RETIRED_MACHINE_KEYS], "");
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
  const notify = c.optionalBoolean(root, "", "notify", true);
  checkUnknownKeys(c, root);

  if (
    ghConfigDir === undefined ||
    pollSeconds === undefined ||
    maxConcurrentRuns === undefined ||
    maxConcurrentGates === undefined ||
    notify === undefined
  ) {
    return undefined;
  }
  return {
    ghConfigDir,
    pollSeconds,
    maxConcurrentRuns,
    maxConcurrentGates,
    notify,
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

/**
 * Whether a checkout's `.dw/config.yml` opts the repo into the factory: the root is a mapping and
 * its `factory` is a mapping. It does not validate the block: `world.project` reads and validates
 * the GitHub copy, and a block that does not load shows up as that repo's config errors.
 */
export const hasFactoryBlock = (text: string): boolean => {
  let value: unknown;
  try {
    value = parse(text, { intAsBigInt: true });
  } catch {
    return false;
  }
  return isMapping(value) && isMapping(value["factory"]);
};

export const parseMachineConfig = (
  text: string,
  file: string,
): Result.Result<LoadedMachineConfig, ReadonlyArray<ConfigError>> => {
  const c = makeChecker(file);
  const parsed = c.root(text);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const config = machineFrom(c, parsed.success);
  return c.finish(config === undefined ? undefined : { config, warnings: c.warnings });
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
): Effect.Effect<Option.Option<LoadedMachineConfig>, ConfigErrors, FileSystem.FileSystem> =>
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
    if (Option.isNone(text)) return Option.none<LoadedMachineConfig>();
    return Option.some(yield* toConfigErrors(file, parseMachineConfig(text.value, file)));
  });
