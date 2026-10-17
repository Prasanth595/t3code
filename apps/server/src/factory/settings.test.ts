// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real config files and read them back.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe } from "vite-plus/test";

import { parseMachineConfig } from "./config.ts";
import { useTempDirs } from "./ledger/testSupport.ts";
import {
  editMachineConfig,
  isJsonObject,
  readMachineConfigReport,
  writeMachineConfig,
} from "./settings.ts";

const tempDir = useTempDirs();

const FILE = "/factory/config.yml";

const COMMENTED = `# The factory on this machine.
# Edited by hand; keep the comments.

# where gh keeps its login
gh_config_dir: /gh # trailing note
# how often a pass runs
poll_seconds: 60
# runs at once
max_concurrent_runs: 1
# the model
model_instance: claudeAgent
model: claude-sonnet-5-5
# notifications stay a hand edit
notify: false
# the repos
repos:
  # the main repo
  - repo: a/b # primary
    path: /b
# end of file
`;

const commentLines = (text: string) =>
  text.split("\n").filter((line) => line.trimStart().startsWith("#") || line.includes(" # "));

const edited = (existing: string | null, body: unknown) => {
  const result = editMachineConfig(existing, body);
  if (Result.isFailure(result)) assert.fail(JSON.stringify(result.failure));
  return result.success;
};

describe("editMachineConfig", () => {
  it("keeps every comment and the keys the form does not edit", () => {
    const text = edited(COMMENTED, {
      gh_config_dir: "/other",
      poll_seconds: 90,
      max_concurrent_runs: 3,
      model: "claude-opus-4-8",
      repos: [
        { repo: "a/b", path: "/b2" },
        { repo: "c/d", path: "/d" },
      ],
    });
    const after = text.split("\n");
    for (const line of commentLines(COMMENTED).map((l) => l.trim())) {
      // A comment that sat after a value stays after it; the value on its line may have changed.
      const comment = line.includes(" # ") ? `# ${line.split(" # ")[1]}` : line;
      assert.ok(
        after.some((l) => l.includes(comment)),
        `lost: ${comment}\n${text}`,
      );
    }
    const parsed = parseMachineConfig(text, FILE);
    assert.deepStrictEqual(Result.isSuccess(parsed) && parsed.success, {
      ghConfigDir: "/other",
      pollSeconds: 90,
      maxConcurrentRuns: 3,
      maxConcurrentGates: 2,
      modelInstance: "claudeAgent",
      model: "claude-opus-4-8",
      notify: false,
      repos: [
        { repo: "a/b", path: "/b2" },
        { repo: "c/d", path: "/d" },
      ],
    });
  });

  it("leaves keys absent from the body untouched", () => {
    const text = edited(COMMENTED, { poll_seconds: 120 });
    assert.strictEqual(text, COMMENTED.replace("poll_seconds: 60", "poll_seconds: 120"));
  });

  it("drops repos the body no longer lists", () => {
    const text = edited(COMMENTED, { repos: [{ repo: "x/y", path: "/y" }] });
    const parsed = parseMachineConfig(text, FILE);
    assert.deepStrictEqual(Result.isSuccess(parsed) && parsed.success.repos, [
      { repo: "x/y", path: "/y" },
    ]);
  });

  it("refuses an invalid body with the parser's fields", () => {
    const result = editMachineConfig(COMMENTED, { poll_seconds: 5, model: "", repos: [] });
    assert.ok(Result.isFailure(result));
    const errors = Result.isFailure(result) ? result.failure : [];
    assert.deepStrictEqual(errors.map((e) => e.field).sort(), ["model", "poll_seconds", "repos"]);
    assert.ok(errors.every((e) => e.file === FILE || e.file.length > 0));
  });

  it("gives a float and a string the parser's own messages", () => {
    const result = editMachineConfig(COMMENTED, { poll_seconds: 60.5, max_concurrent_runs: "two" });
    assert.ok(Result.isFailure(result));
    const errors = Result.isFailure(result) ? result.failure : [];
    assert.deepStrictEqual(
      errors.map((e) => [e.field, e.message]),
      [
        ["poll_seconds", "must be an integer of at least 10"],
        ["max_concurrent_runs", "must be an integer"],
      ],
    );
  });

  it("makes a new file from nothing", () => {
    const text = edited(null, {
      gh_config_dir: "/gh",
      poll_seconds: 60,
      max_concurrent_runs: 1,
      max_concurrent_gates: 2,
      model_instance: "claudeAgent",
      model: "m",
      repos: [{ repo: "a/b", path: "/b" }],
    });
    const parsed = parseMachineConfig(text, FILE);
    assert.ok(Result.isSuccess(parsed), text);
  });

  it("copies only repo and path from each repo", () => {
    const text = edited(null, {
      gh_config_dir: "/gh",
      max_concurrent_runs: 1,
      model: "m",
      repos: [{ repo: "a/b", path: "/b", extra: true }],
    });
    assert.notInclude(text, "extra");
  });

  it("recognises a JSON object and nothing else", () => {
    assert.ok(isJsonObject({}));
    assert.ok(!isJsonObject([]));
    assert.ok(!isJsonObject(null));
    assert.ok(!isJsonObject("x"));
  });
});

describe("writeMachineConfig", () => {
  it.effect("writes the text, creates the directory and leaves no temp file", () =>
    Effect.gen(function* () {
      const dir = NodePath.join(tempDir("settings"), "nested");
      const file = NodePath.join(dir, "config.yml");
      yield* writeMachineConfig(file, "a: 1\n");
      yield* writeMachineConfig(file, COMMENTED);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), COMMENTED);
      assert.deepStrictEqual(NodeFS.readdirSync(dir), ["config.yml"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("readMachineConfigReport", () => {
  const report = (text: string | null, readings = new Map()) =>
    Effect.gen(function* () {
      const file = NodePath.join(tempDir("report"), "config.yml");
      if (text !== null) NodeFS.writeFileSync(file, text);
      return { file, report: yield* readMachineConfigReport(file, readings) };
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("reports the defaults for a missing file", () =>
    Effect.gen(function* () {
      const { file, report: r } = yield* report(null);
      assert.deepStrictEqual(r, {
        file,
        exists: false,
        config: {
          gh_config_dir: "",
          poll_seconds: 60,
          max_concurrent_runs: 1,
          max_concurrent_gates: 2,
          model_instance: "claudeAgent",
          model: "",
          repos: [],
        },
        errors: [],
        repos: [],
      });
    }),
  );

  it.effect("reports an invalid file as errors with no config", () =>
    Effect.gen(function* () {
      const { report: r } = yield* report("model: 1\n");
      assert.strictEqual(r.exists, true);
      assert.strictEqual(r.config, null);
      assert.ok(r.errors.length > 0);
      assert.deepStrictEqual(r.repos, []);
    }),
  );

  it.effect("joins the last reading of each repo", () =>
    Effect.gen(function* () {
      const readings = new Map([
        ["a/b", { kind: "errors" as const, errors: [{ file: ".dw/config.yml", message: "bad" }] }],
      ]);
      const two = COMMENTED.replace("# end of file", "  - repo: c/d\n    path: /d\n# end of file");
      const { report: r } = yield* report(two, readings);
      assert.strictEqual(r.exists, true);
      assert.deepStrictEqual(r.errors, []);
      assert.deepStrictEqual(r.repos, [
        {
          repo: "a/b",
          path: "/b",
          factory: null,
          errors: [{ file: ".dw/config.yml", message: "bad" }],
        },
        { repo: "c/d", path: "/d", factory: null, errors: null },
      ]);
    }),
  );
});
