import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { parse, stringify } from "yaml";

import {
  type ConfigError,
  ConfigErrors,
  formatConfigError,
  loadMachineConfig,
  loadProjectConfig,
  parseMachineConfig,
  parseProjectConfig,
  timeLimitOnlyProjectConfig,
} from "./config.ts";

const PROJECT = `
tracker:
  backend: do-work-io
factory:
  instructors: [tomkaczocha]
  base: main
  provision: [cargo fetch]
  gate:
    - cargo fmt --check
    - cargo test
  limits: { minutes: 90, gate_retries: 2 }
  autonomy: pr
`;

const MACHINE = `
gh_config_dir: /Users/me/.config/softfac/gh
max_concurrent_runs: 1
model: claude-sonnet-5-5
repos:
  - repo: rawphp/softfac
    path: /Users/me/EA/projects/softfac
`;

const PFILE = "/r/.dw/config.yml";
const MFILE = "/m/config.yml";

type Tree = any;

const isIndex = (part: string) => /^\d+$/.test(part);
const step = (cur: Tree, part: string): Tree => cur[isIndex(part) ? Number(part) : part];

/** Parse `base`, apply `f` to the plain tree, and return the edited text. */
const edit = (base: string, f: (tree: Tree) => void): string => {
  const tree = parse(base);
  f(tree);
  return stringify(tree);
};

/** Set a dotted path (numeric segments index lists) to the value of the YAML text `yaml`. */
const set = (tree: Tree, path: string, yaml: string) => {
  const parts = path.split(".");
  const parent = parts.slice(0, -1).reduce(step, tree);
  const last = parts[parts.length - 1]!;
  parent[isIndex(last) ? Number(last) : last] = parse(yaml);
};

const remove = (tree: Tree, path: string) => {
  const parts = path.split(".");
  const parent = parts.slice(0, -1).reduce(step, tree);
  delete parent[parts[parts.length - 1]!];
};

const projectErr = (text: string): ReadonlyArray<ConfigError> => {
  const result = parseProjectConfig(text, PFILE);
  if (Result.isSuccess(result)) throw new Error("expected invalid project config");
  return result.failure;
};

const machineErr = (text: string): ReadonlyArray<ConfigError> => {
  const result = parseMachineConfig(text, MFILE);
  if (Result.isSuccess(result)) throw new Error("expected invalid machine config");
  return result.failure;
};

const project = (text: string) => {
  const result = parseProjectConfig(text, PFILE);
  if (Result.isFailure(result))
    throw new Error(`unexpected errors: ${JSON.stringify(result.failure)}`);
  return result.success;
};

const machine = (text: string) => {
  const result = parseMachineConfig(text, MFILE);
  if (Result.isFailure(result))
    throw new Error(`unexpected errors: ${JSON.stringify(result.failure)}`);
  return result.success;
};

/** Assert exactly one error whose field and file are exactly as given. */
const assertOne = (errs: ReadonlyArray<ConfigError>, field: string, file: string) => {
  expect(errs, JSON.stringify(errs)).toHaveLength(1);
  expect(errs[0]!.field).toBe(field);
  expect(errs[0]!.file).toBe(file);
};

/** Assert exactly one file-level error (no field) on `file`. */
const assertFileLevel = (errs: ReadonlyArray<ConfigError>, file: string, messagePart: string) => {
  expect(errs, JSON.stringify(errs)).toHaveLength(1);
  expect(errs[0]!.field).toBeUndefined();
  expect(errs[0]!.file).toBe(file);
  expect(errs[0]!.message).toContain(messagePart);
};

const fields = (errs: ReadonlyArray<ConfigError>) =>
  errs.flatMap((e) => (e.field === undefined ? [] : [e.field]));

const projectMissing = (path: string) => {
  assertOne(projectErr(edit(PROJECT, (t) => remove(t, path))), path, PFILE);
};

const projectBad = (path: string, yaml: string) => {
  assertOne(projectErr(edit(PROJECT, (t) => set(t, path, yaml))), path, PFILE);
};

const machineMissing = (path: string) => {
  assertOne(machineErr(edit(MACHINE, (t) => remove(t, path))), path, MFILE);
};

/** Set `editPath` (tree address, e.g. `repos.0.path`), expect the error at `errorPath` (`repos[0].path`). */
const machineBadAt = (editPath: string, errorPath: string, yaml: string) => {
  assertOne(machineErr(edit(MACHINE, (t) => set(t, editPath, yaml))), errorPath, MFILE);
};

const machineBad = (path: string, yaml: string) => machineBadAt(path, path, yaml);

describe("project config", () => {
  it("the config of a repo that never loaded has the default time limit and no base", () => {
    const config = timeLimitOnlyProjectConfig();
    expect(config.limits.minutes).toBe(180);
    expect(config.limits.gateRetries).toBe(0);
    expect(config.limits.regates).toBe(5);
    expect(config.limits.checksMinutes).toBe(30);
    expect(config.limits.interruptionResumes).toBe(2);
    expect(config.base).toBe("");
    expect(config.autonomy).toBe("pr");
    expect(config.instructors).toEqual([]);
    expect(config.provision).toEqual([]);
    expect(config.gate).toEqual([]);
    expect(config.requiredChecks).toEqual([]);
  });

  describe("valid", () => {
    it("project valid resolves all fields", () => {
      const c = project(PROJECT);
      expect(c.instructors).toEqual(["tomkaczocha"]);
      expect(c.base).toBe("main");
      expect(c.provision).toEqual(["cargo fetch"]);
      expect(c.gate).toEqual(["cargo fmt --check", "cargo test"]);
      expect(c.limits.minutes).toBe(90);
      expect(c.limits.gateRetries).toBe(2);
      expect(c.requiredChecks).toEqual([]);
      expect(c.limits.checksMinutes).toBe(30);
      expect(c.autonomy).toBe("pr");
    });
  });

  describe("the re-gate limit", () => {
    const regates = (value?: string) =>
      project(
        edit(PROJECT, (t) => {
          if (value !== undefined) set(t, "factory.limits.regates", value);
        }),
      ).limits.regates;

    it("project regates defaults to 5 and can be set", () => {
      expect(regates()).toBe(5);
      expect(regates("1")).toBe(1);
      expect(regates("12")).toBe(12);
    });

    it("project regates is read from a limits block written inline", () => {
      const t = PROJECT.replace(
        "limits: { minutes: 90, gate_retries: 2 }",
        "limits: { minutes: 90, gate_retries: 2, regates: 3 }",
      );
      expect(project(t).limits.regates).toBe(3);
    });

    it("project regates must be an integer of at least one", () => {
      for (const bad of ['"many"', "0", "-1", "1.5", "[1]", "null", "true"]) {
        const errs = projectErr(edit(PROJECT, (t) => set(t, "factory.limits.regates", bad)));
        assertOne(errs, "factory.limits.regates", PFILE);
      }
      const errs = projectErr(edit(PROJECT, (t) => set(t, "factory.limits.regates", "0")));
      expect(errs[0]!.message).toBe("must be an integer of at least 1");
    });
  });

  describe("the required checks", () => {
    const CHECKS = "factory.required_checks";
    const CHECKS_MINUTES = "factory.limits.checks_minutes";

    it("project required checks are not supported yet: a non-empty list is one error", () => {
      const errs = projectErr(edit(PROJECT, (t) => set(t, CHECKS, '[gate, "build (linux)"]')));
      assertOne(errs, CHECKS, PFILE);
      expect(errs[0]!.message).toBe("required_checks is not supported yet");
    });

    it("project required checks may be an empty list", () => {
      const c = project(edit(PROJECT, (t) => set(t, CHECKS, "[]")));
      expect(c.requiredChecks).toEqual([]);
    });

    it("project required checks must be a list of non-empty strings", () => {
      for (const bad of ["gate", "5", "null", "[1]", '[""]', '[gate, ""]']) {
        const errs = projectErr(edit(PROJECT, (t) => set(t, CHECKS, bad)));
        expect(errs.length, bad).toBeGreaterThan(0);
        for (const e of errs) expect(e.field?.startsWith(CHECKS), `${bad}: ${e.field}`).toBe(true);
        expect(
          errs.some((e) => e.message === "required_checks is not supported yet"),
          bad,
        ).toBe(false);
      }
      const errs = projectErr(edit(PROJECT, (t) => set(t, CHECKS, '[gate, ""]')));
      assertOne(errs, "factory.required_checks[1]", PFILE);
    });

    it("project checks minutes defaults to 30 and can be set", () => {
      expect(project(edit(PROJECT, (t) => set(t, CHECKS_MINUTES, "45"))).limits.checksMinutes).toBe(
        45,
      );
      expect(project(edit(PROJECT, (t) => set(t, CHECKS_MINUTES, "1"))).limits.checksMinutes).toBe(
        1,
      );
    });

    it("project checks minutes must be an integer of at least one", () => {
      for (const bad of ['"soon"', "0", "-1", "1.5", "[1]", "null", "true"]) {
        const errs = projectErr(edit(PROJECT, (t) => set(t, CHECKS_MINUTES, bad)));
        assertOne(errs, CHECKS_MINUTES, PFILE);
      }
    });
  });

  it("project ignores the needs-info limits an older version read", () => {
    const t = PROJECT.replace(
      "limits: { minutes: 90, gate_retries: 2 }",
      "limits: { minutes: 90, gate_retries: 2, needs_info_nudge_hours: 5, needs_info_timeout_hours: 3, needs_info_rounds: 0 }",
    );
    expect(project(t)).toEqual(project(PROJECT));
  });

  describe("the interruption resumes", () => {
    const RESUMES = "factory.limits.interruption_resumes";
    const withResumes = (resumes: string) => edit(PROJECT, (t) => set(t, RESUMES, resumes));

    it("project interruption resumes default to 2", () => {
      expect(project(PROJECT).limits.interruptionResumes).toBe(2);
    });

    it("project interruption resumes can be set and can be zero", () => {
      for (const [text, want] of [
        ["0", 0],
        ["1", 1],
        ["2", 2],
        ["10", 10],
      ] as const) {
        expect(project(withResumes(text)).limits.interruptionResumes).toBe(want);
      }
    });

    it("project interruption resumes are read from a limits block written inline", () => {
      const t = PROJECT.replace(
        "limits: { minutes: 90, gate_retries: 2 }",
        "limits: { minutes: 90, gate_retries: 2, interruption_resumes: 4 }",
      );
      expect(project(t).limits.interruptionResumes).toBe(4);
    });

    it("project interruption resumes must be an integer of at least zero", () => {
      for (const bad of ['"many"', "-1", "1.5", "[1]", "null", "true"]) {
        assertOne(projectErr(withResumes(bad)), RESUMES, PFILE);
      }
      expect(projectErr(withResumes("-1"))[0]!.message).toBe("must be an integer of at least 0");
    });
  });

  it("project ignores other top level keys", () => {
    const t =
      "tracker: 5\nmodels: [a]\nfactory:\n  instructors: [a]\n  base: main\n  provision: []\n  gate: [make]\n  limits: { minutes: 1, gate_retries: 0 }\n  autonomy: pr\n";
    const c = project(t);
    expect(c.provision).toEqual([]);
    expect(c.limits.gateRetries).toBe(0);
  });

  it("project ignores unknown keys inside the factory block", () => {
    const t = edit(PROJECT, (tree) => set(tree, "factory.something_else", "5"));
    expect(project(t)).toEqual(project(PROJECT));
  });

  describe("missing fields", () => {
    it("project missing factory block", () => {
      assertOne(projectErr("tracker: x\n"), "factory", PFILE);
    });
    it("project missing instructors", () => projectMissing("factory.instructors"));
    it("project missing base", () => projectMissing("factory.base"));
    it("project missing provision", () => projectMissing("factory.provision"));
    it("project missing gate", () => projectMissing("factory.gate"));
    it("project missing limits", () => projectMissing("factory.limits"));
    it("project limits minutes defaults to 180 when missing", () => {
      const t = edit(PROJECT, (tree) => remove(tree, "factory.limits.minutes"));
      expect(project(t).limits.minutes).toBe(180);
    });
    it("project missing limits gate retries", () => projectMissing("factory.limits.gate_retries"));
    it("project missing autonomy", () => projectMissing("factory.autonomy"));
  });

  describe("wrong types and values", () => {
    it("project factory not a mapping", () => {
      assertOne(projectErr("factory: 3\n"), "factory", PFILE);
    });
    it("project instructors not a list", () => projectBad("factory.instructors", "tomkaczocha"));
    it("project instructors empty", () => projectBad("factory.instructors", "[]"));
    it("project instructors item not a string", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.instructors", "[a, 5]"));
      assertOne(projectErr(t), "factory.instructors[1]", PFILE);
    });
    it("project instructors empty item", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.instructors", '[""]'));
      assertOne(projectErr(t), "factory.instructors[0]", PFILE);
    });
    it("project gate empty item", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.gate", '[""]'));
      assertOne(projectErr(t), "factory.gate[0]", PFILE);
    });
    it("project base not a string", () => projectBad("factory.base", "[main]"));
    it("project base empty", () => projectBad("factory.base", '""'));
    it("project provision not a list", () => projectBad("factory.provision", "cargo fetch"));
    it("project provision item not a string", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.provision", "[{a: b}]"));
      assertOne(projectErr(t), "factory.provision[0]", PFILE);
    });
    it("project gate not a list", () => projectBad("factory.gate", "cargo test"));
    it("project gate empty", () => projectBad("factory.gate", "[]"));
    it("project limits not a mapping", () => projectBad("factory.limits", "90"));
    it("project minutes not an integer", () => projectBad("factory.limits.minutes", '"ninety"'));
    it("project minutes zero", () => projectBad("factory.limits.minutes", "0"));
    it("project minutes negative", () => projectBad("factory.limits.minutes", "-5"));
    it("project minutes fractional", () => projectBad("factory.limits.minutes", "1.5"));
    it("project minutes written as 1.0 is fractional", () => {
      const errs = projectErr(edit(PROJECT, (tree) => set(tree, "factory.limits.minutes", "1.0")));
      assertOne(errs, "factory.limits.minutes", PFILE);
    });
    it("project gate retries not an integer", () =>
      projectBad("factory.limits.gate_retries", "many"));
    it("project gate retries negative", () => projectBad("factory.limits.gate_retries", "-1"));
    it("project autonomy merge is rejected with phase note", () => {
      const errs = projectErr(edit(PROJECT, (tree) => set(tree, "factory.autonomy", "merge")));
      assertOne(errs, "factory.autonomy", PFILE);
      expect(errs[0]!.message).toBe("unsupported value `merge`; only `pr` is accepted in phase 1");
    });
    it("project autonomy deploy is rejected", () => projectBad("factory.autonomy", "deploy"));
    it("project autonomy not a string", () => {
      const errs = projectErr(edit(PROJECT, (tree) => set(tree, "factory.autonomy", "7")));
      assertOne(errs, "factory.autonomy", PFILE);
      expect(errs[0]!.message).toBe("must be a string; only `pr` is accepted in phase 1");
    });
    it("project key present with null is a type error, not absent", () => {
      const errs = projectErr(edit(PROJECT, (tree) => set(tree, "factory.base", "null")));
      assertOne(errs, "factory.base", PFILE);
      expect(errs[0]!.message).toBe("must be a string");
    });
  });

  it("project reports all errors not just the first", () => {
    const t = edit(PROJECT, (tree) => {
      remove(tree, "factory.base");
      set(tree, "factory.limits.minutes", "0");
      set(tree, "factory.autonomy", "merge");
    });
    const errs = projectErr(t);
    expect(errs).toHaveLength(3);
    expect(fields(errs)).toEqual(["factory.base", "factory.limits.minutes", "factory.autonomy"]);
  });

  it("project invalid yaml names the file", () => {
    assertFileLevel(projectErr("factory: [unclosed\n"), PFILE, "not valid YAML");
  });

  it("project document not a mapping", () => {
    assertFileLevel(projectErr("- a\n- b\n"), PFILE, "top level must be a mapping");
    assertFileLevel(projectErr(""), PFILE, "top level must be a mapping");
    assertFileLevel(projectErr("5\n"), PFILE, "top level must be a mapping");
  });

  effectIt.effect("project missing file names the file", () =>
    Effect.gen(function* () {
      const file = "/definitely/not/here/.dw/config.yml";
      const failure = yield* Effect.flip(loadProjectConfig(file));
      expect(failure).toBeInstanceOf(ConfigErrors);
      assertFileLevel(failure.errors, file, "cannot read");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("formatConfigError", () => {
  it("names the file, the field and the message", () => {
    expect(formatConfigError({ file: "/m/c.yml", field: "model", message: "is missing" })).toBe(
      "/m/c.yml: model: is missing",
    );
  });
  it("leaves the field out of a file-level error", () => {
    expect(formatConfigError({ file: "/m/c.yml", message: "top level must be a mapping" })).toBe(
      "/m/c.yml: top level must be a mapping",
    );
  });
});

describe("machine config", () => {
  it("machine valid resolves every field and the defaults", () => {
    expect(machine(MACHINE)).toEqual({
      ghConfigDir: "/Users/me/.config/softfac/gh",
      pollSeconds: 60,
      maxConcurrentRuns: 1,
      maxConcurrentGates: 2,
      modelInstance: "claudeAgent",
      model: "claude-sonnet-5-5",
      repos: [{ repo: "rawphp/softfac", path: "/Users/me/EA/projects/softfac" }],
    });
  });

  it("machine every key can be set", () => {
    const t = edit(MACHINE, (tree) => {
      set(tree, "poll_seconds", "10");
      set(tree, "max_concurrent_runs", "3");
      set(tree, "max_concurrent_gates", "4");
      set(tree, "model_instance", "codex");
    });
    const c = machine(t);
    expect(c.pollSeconds).toBe(10);
    expect(c.maxConcurrentRuns).toBe(3);
    expect(c.maxConcurrentGates).toBe(4);
    expect(c.modelInstance).toBe("codex");
  });

  describe("required keys", () => {
    it("machine missing gh config dir", () => machineMissing("gh_config_dir"));
    it("machine missing max concurrent runs", () => machineMissing("max_concurrent_runs"));
    it("machine missing model", () => machineMissing("model"));
    it("machine missing repos", () => machineMissing("repos"));
    it("machine repo missing repo", () => machineMissing("repos.0.repo"));
    it("machine repo missing path", () => {
      const t = edit(MACHINE, (tree) => remove(tree, "repos.0.path"));
      assertOne(machineErr(t), "repos[0].path", MFILE);
      expect(machineErr(t)[0]!.message).toBe("is missing");
    });
  });

  describe("integers", () => {
    it("machine poll seconds below 10 is rejected", () => {
      machineBad("poll_seconds", "9");
      expect(machineErr(edit(MACHINE, (t) => set(t, "poll_seconds", "9")))[0]!.message).toBe(
        "must be an integer of at least 10",
      );
    });
    it("machine poll seconds as a string is not an integer", () => {
      machineBad("poll_seconds", '"60"');
      expect(machineErr(edit(MACHINE, (t) => set(t, "poll_seconds", '"60"')))[0]!.message).toBe(
        "must be an integer",
      );
    });
    it("machine max concurrent runs of 0 is rejected", () => {
      machineBad("max_concurrent_runs", "0");
      expect(machineErr(edit(MACHINE, (t) => set(t, "max_concurrent_runs", "0")))[0]!.message).toBe(
        "must be an integer of at least 1",
      );
    });
    it("machine max concurrent gates of 0 is rejected", () => {
      machineBad("max_concurrent_gates", "0");
      expect(
        machineErr(edit(MACHINE, (t) => set(t, "max_concurrent_gates", "0")))[0]!.message,
      ).toBe("must be an integer of at least 1");
    });
  });

  describe("strings", () => {
    for (const key of ["model", "model_instance", "gh_config_dir"]) {
      it(`machine ${key} empty`, () => {
        machineBad(key, '""');
        expect(machineErr(edit(MACHINE, (t) => set(t, key, '""')))[0]!.message).toBe(
          "must not be empty",
        );
      });
      it(`machine ${key} not a string`, () => {
        machineBad(key, "[x]");
        expect(machineErr(edit(MACHINE, (t) => set(t, key, "[x]")))[0]!.message).toBe(
          "must be a string",
        );
      });
    }
  });

  describe("repos", () => {
    it("machine repos as a string is not a list", () => {
      machineBad("repos", "nope");
      expect(machineErr(edit(MACHINE, (t) => set(t, "repos", "nope")))[0]!.message).toBe(
        "must be a list",
      );
    });
    it("machine repos empty", () => {
      machineBad("repos", "[]");
      expect(machineErr(edit(MACHINE, (t) => set(t, "repos", "[]")))[0]!.message).toBe(
        "must not be empty",
      );
    });
    it("machine repo item not a mapping", () => {
      machineBadAt("repos.0", "repos[0]", "5");
      expect(machineErr(edit(MACHINE, (t) => set(t, "repos.0", "5")))[0]!.message).toBe(
        "must be a mapping",
      );
    });
    it("machine repo and path must be non-empty strings", () => {
      machineBadAt("repos.0.repo", "repos[0].repo", '""');
      machineBadAt("repos.0.path", "repos[0].path", "[x]");
    });
    it("machine reads several repos in order", () => {
      const t = edit(MACHINE, (tree) => {
        tree.repos.push({ repo: "a/b", path: "/b" });
      });
      expect(machine(t).repos.map((r) => r.repo)).toEqual(["rawphp/softfac", "a/b"]);
    });
  });

  describe("unknown keys", () => {
    it("machine unknown top-level key is one file-level error", () => {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "self_updte", "1")));
      assertFileLevel(errs, MFILE, "unknown key self_updte");
      expect(formatConfigError(errs[0]!)).toBe(`${MFILE}: unknown key self_updte`);
    });
    it("machine unknown key inside a repo is named by its path", () => {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "repos.0.pathh", "x")));
      assertFileLevel(errs, MFILE, "unknown key repos[0].pathh");
    });
    it("machine two unknown keys are two errors, after the field errors", () => {
      const t = edit(MACHINE, (tree) => {
        set(tree, "zzz", "1");
        remove(tree, "model");
        set(tree, "repos.0.pathh", "x");
      });
      const errs = machineErr(t);
      expect(errs.map(formatConfigError)).toEqual([
        `${MFILE}: model: is missing`,
        `${MFILE}: unknown key zzz`,
        `${MFILE}: unknown key repos[0].pathh`,
      ]);
    });
    it("machine does not look for unknown keys inside a value of the wrong type", () => {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "repos", "{a: 1}")));
      assertOne(errs, "repos", MFILE);
    });
  });

  it("machine reports all errors together", () => {
    const t = edit(MACHINE, (tree) => {
      remove(tree, "model");
      set(tree, "poll_seconds", "1");
      set(tree, "max_concurrent_runs", "0");
    });
    expect(fields(machineErr(t))).toEqual(["poll_seconds", "max_concurrent_runs", "model"]);
  });

  it("machine invalid yaml names the file", () => {
    assertFileLevel(machineErr("repos: [unclosed\n"), MFILE, "not valid YAML");
  });

  it("machine document not a mapping", () => {
    assertFileLevel(machineErr("- a\n"), MFILE, "top level must be a mapping");
    assertFileLevel(machineErr(""), MFILE, "top level must be a mapping");
  });
});

describe("loaders", () => {
  const withTempDir = <A, E>(
    body: (dir: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-config-" });
        return yield* body(dir, fs, path);
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  effectIt.effect("loadMachineConfig on a missing path is none", () =>
    withTempDir((dir, _fs, path) =>
      Effect.gen(function* () {
        const loaded = yield* loadMachineConfig(path.join(dir, "nope.yml"));
        expect(Option.isNone(loaded)).toBe(true);
      }),
    ),
  );

  effectIt.effect("loadMachineConfig reads the file on every call", () =>
    withTempDir((dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "config.yml");
        yield* fs.writeFileString(file, MACHINE);
        const first = yield* loadMachineConfig(file);
        expect(Option.map(first, (c) => c.model)).toEqual(Option.some("claude-sonnet-5-5"));

        yield* fs.writeFileString(file, MACHINE.replace("claude-sonnet-5-5", "claude-opus-4-8"));
        const second = yield* loadMachineConfig(file);
        expect(Option.map(second, (c) => c.model)).toEqual(Option.some("claude-opus-4-8"));
      }),
    ),
  );

  effectIt.effect("loadMachineConfig fails with every error of an invalid file", () =>
    withTempDir((dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "config.yml");
        yield* fs.writeFileString(file, MACHINE.replace("model: claude-sonnet-5-5\n", ""));
        const failure = yield* Effect.flip(loadMachineConfig(file));
        expect(failure.errors.map(formatConfigError)).toEqual([`${file}: model: is missing`]);
      }),
    ),
  );

  effectIt.effect("loadMachineConfig on a directory fails with cannot read file", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(loadMachineConfig(dir));
        assertFileLevel(failure.errors, dir, "cannot read file: ");
      }),
    ),
  );

  effectIt.effect("loadProjectConfig reads the file on every call", () =>
    withTempDir((dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "config.yml");
        yield* fs.writeFileString(file, PROJECT);
        expect((yield* loadProjectConfig(file)).base).toBe("main");
        yield* fs.writeFileString(file, PROJECT.replace("base: main", "base: develop"));
        expect((yield* loadProjectConfig(file)).base).toBe("develop");
      }),
    ),
  );
});
