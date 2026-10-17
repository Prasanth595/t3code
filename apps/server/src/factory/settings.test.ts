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
import { editMachineConfig, isJsonObject, readMachineConfigReport } from "./settings.ts";

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

const edited = (existing: string | null, body: Record<string, unknown>) => {
  const result = editMachineConfig(existing, body, FILE);
  if (Result.isFailure(result)) assert.fail(JSON.stringify(result.failure));
  return result.success;
};

describe("editMachineConfig", () => {
  it("keeps every comment and the keys the form does not edit", () => {
    const text = edited(COMMENTED, {
      gh_config_dir: "/other",
      poll_seconds: 90,
      max_concurrent_runs: 3,
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
    assert.deepStrictEqual(Result.isSuccess(parsed) && parsed.success.config, {
      ghConfigDir: "/other",
      pollSeconds: 90,
      maxConcurrentRuns: 3,
      maxConcurrentGates: 2,
      notify: false,
      repos: [
        { repo: "a/b", path: "/b2" },
        { repo: "c/d", path: "/d" },
      ],
    });
  });

  it("leaves keys absent from the body untouched", () => {
    const text = edited(COMMENTED, { poll_seconds: 120 });
    // The yaml printer may add a blank line before a trailing comment; nothing else moves.
    const unblank = (value: string) => value.replace(/\n{2,}/g, "\n");
    assert.strictEqual(
      unblank(text),
      unblank(COMMENTED.replace("poll_seconds: 60", "poll_seconds: 120")),
    );
    assert.strictEqual(edited(text, { poll_seconds: 120 }), text);
  });

  it("drops repos the body no longer lists", () => {
    const text = edited(COMMENTED, { repos: [{ repo: "x/y", path: "/y" }] });
    const parsed = parseMachineConfig(text, FILE);
    assert.deepStrictEqual(Result.isSuccess(parsed) && parsed.success.config.repos, [
      { repo: "x/y", path: "/y" },
    ]);
  });

  // #93 retired the two keys: a save from the page takes them out of the file, so the running
  // factory stops warning about them, and touches nothing else.
  it("deletes the retired model_instance and model keys and keeps every other key and comment", () => {
    const retired = COMMENTED.replace(
      "# notifications stay a hand edit",
      "model_instance: claudeAgent\nmodel: claude-sonnet-5-5\n# notifications stay a hand edit",
    );
    const text = edited(retired, { poll_seconds: 60 });
    assert.notInclude(text, "model_instance");
    assert.notInclude(text, "model:");
    const unblank = (value: string) => value.replace(/\n{2,}/g, "\n");
    assert.strictEqual(unblank(text), unblank(COMMENTED));
  });

  describe("repos", () => {
    const TWO = COMMENTED.replace(
      "# end of file",
      "  # the second repo\n  - repo: c/d # secondary\n    path: /d\n# end of file",
    );

    it("matches a repo by name: removing the first leaves the second's comments on it", () => {
      const text = edited(TWO, { repos: [{ repo: "c/d", path: "/d" }] });
      assert.include(text, "# the second repo");
      assert.include(text, "# secondary");
      assert.notInclude(text, "# primary");
      assert.notInclude(text, "a/b");
    });

    it("orders the repos as the body does and keeps each one's comments", () => {
      const text = edited(TWO, {
        repos: [
          { repo: "c/d", path: "/d" },
          { repo: "a/b", path: "/b" },
        ],
      });
      assert.ok(text.indexOf("c/d") < text.indexOf("a/b"), text);
      assert.ok(text.indexOf("# secondary") < text.indexOf("a/b"), text);
      assert.ok(text.indexOf("# primary") > text.indexOf("a/b"), text);
    });

    it("replaces a matched repo's fields wholesale: a missing path is not kept", () => {
      const result = editMachineConfig(TWO, { repos: [{ repo: "a/b" }] }, FILE);
      assert.ok(Result.isFailure(result));
      const errors = Result.isFailure(result) ? result.failure : [];
      assert.deepStrictEqual(
        errors.map((e) => e.field),
        ["repos[0].path"],
      );
    });
  });

  describe("a typo inside a repo block", () => {
    it("is dropped by an edit, and the comments on the repo stay", () => {
      const text = [
        "gh_config_dir: /gh",
        "poll_seconds: 60",
        "max_concurrent_runs: 1",
        "repos:",
        "  # the main repo",
        "  - repo: a/b # primary",
        "    paht: /x",
        "",
      ].join("\n");
      const result = editMachineConfig(text, { repos: [{ repo: "a/b", path: "/b" }] }, FILE);
      assert.ok(Result.isSuccess(result), JSON.stringify(result));
      const out = Result.isSuccess(result) ? result.success : "";
      assert.include(out, "# the main repo");
      assert.include(out, "# primary");
      assert.notInclude(out, "paht");
      assert.include(out, "path: /b");
    });
  });

  describe("files the page could not fix before", () => {
    const BODY = {
      gh_config_dir: "/gh",
      poll_seconds: 60,
      max_concurrent_runs: 1,
      repos: [{ repo: "a/b", path: "/b" }],
    };

    it("drops an unknown top-level key, keeps notify and the comments", () => {
      const text = edited(COMMENTED + "pol_seconds: 5\n", { poll_seconds: 90 });
      assert.notInclude(text, "pol_seconds");
      assert.include(text, "notify: false");
      assert.include(text, "# notifications stay a hand edit");
      assert.include(text, "poll_seconds: 90");
    });

    it("starts from an empty document when the existing file is not YAML", () => {
      const text = edited("poll_seconds: [unclosed\n  - : :\n", BODY);
      const parsed = parseMachineConfig(text, FILE);
      assert.ok(Result.isSuccess(parsed), text);
    });
  });

  it("refuses an invalid body with the parser's fields", () => {
    const result = editMachineConfig(
      COMMENTED,
      { poll_seconds: 5, gh_config_dir: "", repos: [] },
      FILE,
    );
    assert.ok(Result.isFailure(result));
    const errors = Result.isFailure(result) ? result.failure : [];
    assert.deepStrictEqual(errors.map((e) => e.field).sort(), [
      "gh_config_dir",
      "poll_seconds",
      "repos",
    ]);
    assert.ok(errors.every((e) => e.file === FILE));
  });

  it("gives a float and a string the parser's own messages", () => {
    const result = editMachineConfig(
      COMMENTED,
      { poll_seconds: 60.5, max_concurrent_runs: "two" },
      FILE,
    );
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
      repos: [{ repo: "a/b", path: "/b" }],
    });
    const parsed = parseMachineConfig(text, FILE);
    assert.ok(Result.isSuccess(parsed), text);
  });

  it("copies only repo and path from each repo", () => {
    const text = edited(null, {
      gh_config_dir: "/gh",
      max_concurrent_runs: 1,
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

const DEFAULTS = {
  gh_config_dir: "",
  poll_seconds: 60,
  max_concurrent_runs: 1,
  max_concurrent_gates: 2,
  repos: [],
};

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
        config: DEFAULTS,
        defaults: DEFAULTS,
        errors: [],
        repos: [],
      });
    }),
  );

  it.effect("reports an invalid file as errors with no config", () =>
    Effect.gen(function* () {
      const { report: r } = yield* report("poll_seconds: 1\n");
      assert.strictEqual(r.exists, true);
      assert.strictEqual(r.config, null);
      assert.ok(r.errors.length > 0);
      assert.deepStrictEqual(r.repos, []);
    }),
  );

  it.effect("gives the form its draft: the values an invalid file holds, as written", () =>
    Effect.gen(function* () {
      const { report: r } = yield* report(COMMENTED.replace("poll_seconds: 60", "poll_seconds: 5"));
      assert.strictEqual(r.config, null);
      assert.deepStrictEqual(r.defaults, DEFAULTS);
      assert.deepStrictEqual(r.draft, {
        gh_config_dir: "/gh",
        poll_seconds: 5,
        max_concurrent_runs: 1,
        repos: [{ repo: "a/b", path: "/b" }],
      });
    }),
  );

  it.effect("copies only what is a string, a number or a repo mapping into the draft", () =>
    Effect.gen(function* () {
      const { report: r } = yield* report(
        "poll_seconds: [1]\ngh_config_dir: /x\nrepos:\n  - repo: a/b\n    path: 7\n  - nope\n  - {path: /p}\n",
      );
      assert.deepStrictEqual(r.draft, {
        gh_config_dir: "/x",
        repos: [{ repo: "a/b" }, { path: "/p" }],
      });
    }),
  );

  it.effect("gives an empty draft for a file that is not YAML, and none for a good file", () =>
    Effect.gen(function* () {
      const broken = yield* report("poll_seconds: [unclosed\n");
      assert.strictEqual(broken.report.config, null);
      assert.deepStrictEqual(broken.report.draft, {});
      const good = yield* report(COMMENTED);
      assert.isFalse("draft" in good.report);
      assert.deepStrictEqual(good.report.defaults, DEFAULTS);
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
