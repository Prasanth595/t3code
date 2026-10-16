import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PROJECT_CONFIG_PATH } from "../config.ts";
import type { Approval, Refusal, TextCheck } from "../domain/approval.ts";
import { FactoryProcess, type RunInput, type RunResult, RunSpawnError } from "../process.ts";
import { APPROVAL_QUERY } from "./approvalHistory.ts";
import {
  GitHubFailed,
  GitHubInvalidArgument,
  GitHubOutputTooLarge,
  GitHubParse,
  GitHubRateLimited,
  GitHubSpawnError,
  GitHubTimedOut,
  ClaimMemo,
  LIST_LIMIT,
  MARKER,
  MAX_DEPENDS_ON,
  MAX_FILE_BYTES,
  STATUS_MARKER,
  type Blocker,
  type GitHubError,
  isNotFound,
  makeGitHub,
} from "./github.ts";

// ---- the fake FactoryProcess: records every call, answers from a queue ----

type Answer =
  | { readonly kind: "result"; readonly result: Partial<RunResult> }
  | { readonly kind: "spawn" };

const reply = (stdout: string, stderr = ""): Answer => ({
  kind: "result",
  result: { exitCode: 0, tail: stdout, stderrTail: stderr },
});
const fail = (status: number, stderr: string): Answer => ({
  kind: "result",
  result: { exitCode: status, stderrTail: stderr },
});
const signalKilled = (): Answer => ({ kind: "result", result: { exitCode: null } });
const spawnError = (): Answer => ({ kind: "spawn" });
const timedOut = (): Answer => ({ kind: "result", result: { exitCode: null, timedOut: true } });
const truncated = (): Answer => ({ kind: "result", result: { exitCode: 0, truncated: true } });

const REPO = "rawphp/softfac";
const GH_CONFIG_DIR = "/factory-test/gh-config";

const setup = (...answers: ReadonlyArray<Answer>) => {
  const queue = [...answers];
  const inputs: Array<RunInput> = [];
  const layer = Layer.succeed(
    FactoryProcess,
    FactoryProcess.of({
      run: (input) => {
        inputs.push(input);
        const answer = queue.shift();
        if (answer === undefined || answer.kind === "spawn") {
          return Effect.fail(
            new RunSpawnError({
              shell: false,
              cause: new Error(answer === undefined ? "no queued output" : "gh not found"),
            }),
          );
        }
        return Effect.succeed({
          exitCode: 0,
          timedOut: false,
          tail: "",
          stderrTail: "",
          truncated: false,
          ...answer.result,
        } satisfies RunResult);
      },
    }),
  );
  return {
    github: makeGitHub({ repo: REPO, ghConfigDir: GH_CONFIG_DIR }),
    inputs,
    calls: (): ReadonlyArray<ReadonlyArray<string>> => inputs.map((input) => input.args ?? []),
    ok: <A>(effect: Effect.Effect<A, GitHubError, FactoryProcess>) =>
      effect.pipe(Effect.provide(layer)),
    err: <A>(effect: Effect.Effect<A, GitHubError, FactoryProcess>) =>
      Effect.flip(effect).pipe(Effect.provide(layer)),
  };
};

// ---- recorded gh output ----

const BASE_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const refReply = (sha: string) =>
  `{"ref":"refs/heads/main","node_id":"REF_x","url":"https://api.github.com/repos/rawphp/softfac/git/refs/heads/main","object":{"sha":"${sha}","type":"commit","url":"https://api.github.com/repos/rawphp/softfac/git/commits/${sha}"}}`;

const FILE_SHA = BASE_SHA;
const CONFIG_TEXT = "factory:\n  instructors: [tomkaczocha]\n  base: main\n";
const CONFIG_B64 = "ZmFjdG9yeToKICBpbnN0cnVjdG9yczogW3RvbWthY3pvY2hhXQogIGJhc2U6IG1haW4K\n";

const fileReply = (kind: string, encoding: string, size: number, content: string) =>
  `{"name":"config.yml","path":".dw/config.yml","sha":"abc","size":${size},"url":"https://api.github.com/repos/rawphp/softfac/contents/.dw/config.yml?ref=main","type":"${kind}","content":${JSON.stringify(content)},"encoding":"${encoding}","_links":{"self":"x"}}`;

const LIST_ONE =
  '[{"assignees":[{"id":"MDQ6VXNlcjE=","login":"rawphp","name":"Tom"}],"number":6,"title":"GitHub client"}]';
const LIST_MANY =
  '[{"assignees":[],"number":6,"title":"GitHub client"},{"assignees":[{"login":"a"},{"login":"b"}],"number":9,"title":"Daemon loop"}]';

const listingOf = (count: number) =>
  `[${Array.from({ length: count }, (_, i) => count - i)
    .map((n) => `{"assignees":[],"number":${n},"title":"issue ${n}"}`)
    .join(",")}]`;

const labelsReply = (names: ReadonlyArray<string>) =>
  `{"labels":[${names
    .map((n) => `{"id":"LA_1","name":"${n}","description":"d","color":"0e8a16"}`)
    .join(",")}]}`;

const editCall = (...rest: ReadonlyArray<string>) => [
  "issue",
  "edit",
  "6",
  "--repo",
  REPO,
  ...rest,
];
const viewLabelsCall = ["issue", "view", "6", "--repo", REPO, "--json", "labels"];
const commentCall = (issue: string, body: string) => [
  "issue",
  "comment",
  issue,
  "--repo",
  REPO,
  "--body",
  body,
];
const listCommentsCall = ["api", "repos/rawphp/softfac/issues/6/comments", "--paginate"];
const patchCall = (id: string, body: string) => [
  "api",
  "-X",
  "PATCH",
  `repos/rawphp/softfac/issues/comments/${id}`,
  "-f",
  `body=${body}`,
];

const ISSUE_VIEW =
  '{"assignees":[{"login":"rawphp"}],"author":{"id":"MDQ6VXNlcjE=","is_bot":false,"login":"tomkaczocha","name":"Tom"},"body":"Build the runner.\\n\\n- one\\n- two","labels":[{"name":"factory:ready"},{"name":"phase:1"}],"number":10,"state":"OPEN","title":"Build step"}';
const issueViewCall = [
  "issue",
  "view",
  "10",
  "--repo",
  REPO,
  "--json",
  "number,title,body,labels,assignees,state,author",
];
const issueJson = (labels: ReadonlyArray<string>, assignees: ReadonlyArray<string>, body: string) =>
  `{"assignees":[${assignees.map((n) => `{"login":"${n}"}`).join(",")}],"author":null,"body":${body},"labels":[${labels.map((n) => `{"name":"${n}"}`).join(",")}],"number":10,"state":"OPEN","title":"Build step"}`;

// ---- every call goes through gh with the same settings ----

it.effect("runs gh with the config dir, a 60 s limit and separate stderr on every call", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), reply("[]"), reply(ISSUE_VIEW), reply(""));
    yield* t.ok(t.github.listIssues("ready"));
    yield* t.ok(t.github.listIssues("ready"));
    yield* t.ok(t.github.issue(10));
    yield* t.ok(t.github.assign(6, "rawphp"));
    assert.strictEqual(t.inputs.length, 4);
    for (const input of t.inputs) {
      assert.strictEqual(input.command, "gh");
      assert.strictEqual(input.env?.GH_CONFIG_DIR, GH_CONFIG_DIR);
      assert.strictEqual(input.separateStderr, true);
      assert.strictEqual(input.timeoutMs, 60_000);
      assert.strictEqual(input.tailBytes, 8 * 1024 * 1024);
      assert.notStrictEqual(input.shell, true);
    }
  }),
);

// ---- branchTip ----

it.effect("branchTip reads the full commit id of the branch with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(refReply(BASE_SHA)));
    assert.strictEqual(yield* t.ok(t.github.branchTip("main")), BASE_SHA);
    assert.deepStrictEqual(t.calls(), [["api", "repos/rawphp/softfac/git/ref/heads/main"]]);
  }),
);

it.effect("branchTip keeps slashes in the branch and encodes everything else", () =>
  Effect.gen(function* () {
    const t = setup(reply(refReply(BASE_SHA)), reply(refReply(BASE_SHA)));
    yield* t.ok(t.github.branchTip("release/1.0"));
    yield* t.ok(t.github.branchTip("a b?c#d%e"));
    const calls = t.calls();
    assert.strictEqual(calls[0]![1], "repos/rawphp/softfac/git/ref/heads/release/1.0");
    assert.strictEqual(calls[1]![1], "repos/rawphp/softfac/git/ref/heads/a%20b%3Fc%23d%25e");
  }),
);

it.effect("branchTip refuses an answer that is not a commit id or not a commit", () =>
  Effect.gen(function* () {
    for (const answer of [
      refReply("main"),
      refReply("9f8e7d6c5b4a3928"),
      refReply(BASE_SHA.toUpperCase()).replace("commit", "tag"),
      '{"object":{"type":"commit"}}',
      "[]",
      "not json",
    ]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.branchTip("main"));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("branchTip accepts a 64 digit id", () =>
  Effect.gen(function* () {
    const sha = "a".repeat(64);
    const t = setup(reply(refReply(sha)));
    assert.strictEqual(yield* t.ok(t.github.branchTip("main")), sha);
  }),
);

it.effect("branchTip refuses a branch name that could leave the refs path, with no call", () =>
  Effect.gen(function* () {
    for (const branch of ["", "..", "../x", "a/../b", "./x", "/x", "x//y", "x/"]) {
      const t = setup(reply(refReply(BASE_SHA)));
      const error = yield* t.err(t.github.branchTip(branch));
      assert.strictEqual(error._tag, "GitHubInvalidArgument", branch);
      assert.deepStrictEqual(t.calls(), [], branch);
      assert.notInclude(error.message, "unexpected output", branch);
    }
  }),
);

it.effect("branchTip of a branch that is not there is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    const error = yield* t.err(t.github.branchTip("gone"));
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.isTrue(isNotFound(error));
  }),
);

// ---- defaultBranch ----

it.effect("defaultBranch reads the repo from the API with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        '{"id":1,"name":"softfac","full_name":"rawphp/softfac","default_branch":"main","private":true}',
      ),
    );
    assert.strictEqual(yield* t.ok(t.github.defaultBranch()), "main");
    assert.deepStrictEqual(t.calls(), [["api", "repos/rawphp/softfac"]]);
  }),
);

it.effect("defaultBranch refuses an answer without one", () =>
  Effect.gen(function* () {
    for (const answer of [
      '{"name":"softfac"}',
      '{"default_branch":""}',
      '{"default_branch":null}',
      "[]",
      "no",
    ]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.defaultBranch());
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

// ---- fileAt ----

it.effect("fileAt reads a file at a commit with the exact call and decodes it", () =>
  Effect.gen(function* () {
    const t = setup(reply(fileReply("file", "base64", 51, CONFIG_B64)));
    assert.strictEqual(yield* t.ok(t.github.fileAt(".dw/config.yml", FILE_SHA)), CONFIG_TEXT);
    assert.deepStrictEqual(t.calls(), [
      ["api", `repos/rawphp/softfac/contents/.dw/config.yml?ref=${FILE_SHA}`],
    ]);
  }),
);

it.effect("fileAt decodes content wrapped over several lines and padded", () =>
  Effect.gen(function* () {
    const b64 =
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh\nYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQo=\n";
    const t = setup(reply(fileReply("file", "base64", 101, b64)));
    assert.strictEqual(
      yield* t.ok(t.github.fileAt(".dw/config.yml", FILE_SHA)),
      `${"a".repeat(100)}\n`,
    );
  }),
);

it.effect("fileAt refuses a file over the size cap even when its content is whole", () =>
  Effect.gen(function* () {
    // The size check must refuse it on its own: the content matches the stated size.
    const size = MAX_FILE_BYTES + 1;
    const t = setup(reply(fileReply("file", "base64", size, btoa("a".repeat(size)))));
    const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
    assert.strictEqual(error._tag, "GitHubParse");
    assert.ok(
      error._tag === "GitHubParse" && error.expected.includes("it is too big"),
      error.message,
    );
  }),
);

it.effect("fileAt refuses what is not a plain complete file", () =>
  Effect.gen(function* () {
    for (const answer of [
      // A directory is a JSON array.
      '[{"type":"file","name":"config.yml"}]',
      fileReply("symlink", "base64", 51, CONFIG_B64),
      fileReply("submodule", "base64", 51, CONFIG_B64),
      // A file over 1 MB comes with no content and the encoding `none`.
      fileReply("file", "none", 2_000_000, ""),
      // Under the size cap, but the content is not base64 even though it reads like it.
      fileReply("file", "none", 51, CONFIG_B64),
      fileReply("file", "utf-8", 51, CONFIG_B64),
      // The size says more than the content holds: truncated.
      fileReply("file", "base64", 5_000, CONFIG_B64),
      fileReply("file", "base64", 10, CONFIG_B64),
      // Over the size this reader accepts, whatever the content says.
      fileReply("file", "base64", MAX_FILE_BYTES + 1, CONFIG_B64),
      // Not base64, not UTF-8.
      fileReply("file", "base64", 51, "!!!not base64!!!"),
      fileReply("file", "base64", 3, "//4K\n"),
      "not json",
    ]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("fileAt refuses base64 whose padding does not fit its length", () =>
  Effect.gen(function* () {
    // `YQ==` is "a" and `YWI=` is "ab". One `=` after two characters, or two after three,
    // is not base64.
    for (const [b64, size] of [
      ["YQ=", 1],
      ["YWI==", 2],
      ["YQ", 1],
      ["YQ==YQ==", 2],
    ] as const) {
      const t = setup(reply(fileReply("file", "base64", size, b64)));
      const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
      assert.strictEqual(error._tag, "GitHubParse", b64);
    }
    for (const [b64, want] of [
      ["YQ==", "a"],
      ["YWI=", "ab"],
    ] as const) {
      const t = setup(reply(fileReply("file", "base64", want.length, b64)));
      assert.strictEqual(yield* t.ok(t.github.fileAt(".dw/config.yml", FILE_SHA)), want);
    }
  }),
);

it.effect(
  "fileAt makes no call for a ref that is not a full commit id or a path that could leave",
  () =>
    Effect.gen(function* () {
      for (const [path, sha] of [
        [".dw/config.yml", "main"],
        [".dw/config.yml", "9f8e7d6c"],
        [".dw/config.yml", "9f8e7d6c5b4a39281706f5e4d3c2b1a09876543g"],
        ["../x", FILE_SHA],
        ["a//b", FILE_SHA],
        ["", FILE_SHA],
        ["a b", FILE_SHA],
        ["a?ref=main", FILE_SHA],
      ] as const) {
        const t = setup(reply(fileReply("file", "base64", 51, CONFIG_B64)));
        const error = yield* t.err(t.github.fileAt(path, sha));
        assert.strictEqual(error._tag, "GitHubInvalidArgument", `${path} ${sha}`);
        assert.deepStrictEqual(t.calls(), [], `${path} ${sha}`);
        assert.notInclude(error.message, "unexpected output", `${path} ${sha}`);
      }
    }),
);

it.effect("fileAt of a file that is not there is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

// ---- labelNames, createLabel, ensureLabels ----

/** Literal copies of softfac's lifecycle.rs table, so drift in either module is caught. */
const LABEL_TABLE = [
  [
    "proposed",
    "c5def5",
    "A bot filed it. The factory ignores it until a person sets `factory:ready`.",
  ],
  ["ready", "0e8a16", "Approved for the factory."],
  ["triage", "fbca04", "Claimed. The session is being launched."],
  [
    "needs-info",
    "d93f0b",
    "The factory asked questions on the issue. Answer them, then set `factory:ready`.",
  ],
  ["building", "1d76db", "A session is building it."],
  ["pr-open", "5319e7", "The PR is open and has passed the gate."],
  ["stuck", "b60205", "The factory gave up and said why in a comment."],
] as const;
const ALL_LABEL_NAMES = LABEL_TABLE.map(([state]) => `factory:${state}`);
const createCall = (state: string, color: string, description: string) => [
  "label",
  "create",
  `factory:${state}`,
  "--repo",
  REPO,
  "--color",
  color,
  "--description",
  description,
];

it.effect("ensureLabels on an empty repo creates all seven labels exactly", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), ...LABEL_TABLE.map(() => reply("")));
    const created = yield* t.ok(t.github.ensureLabels());
    assert.deepStrictEqual(
      created,
      LABEL_TABLE.map(([state]) => state),
    );
    assert.deepStrictEqual(t.calls().slice(1), [
      createCall(
        "proposed",
        "c5def5",
        "A bot filed it. The factory ignores it until a person sets `factory:ready`.",
      ),
      createCall("ready", "0e8a16", "Approved for the factory."),
      createCall("triage", "fbca04", "Claimed. The session is being launched."),
      createCall(
        "needs-info",
        "d93f0b",
        "The factory asked questions on the issue. Answer them, then set `factory:ready`.",
      ),
      createCall("building", "1d76db", "A session is building it."),
      createCall("pr-open", "5319e7", "The PR is open and has passed the gate."),
      createCall("stuck", "b60205", "The factory gave up and said why in a comment."),
    ]);
  }),
);

it.effect("labelNames lists every page with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('[{"name":"bug","color":"d73a4a"}]'),
      reply("[]"),
      reply('[{"name":"a"}][{"name":"b"}]'),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.labelNames()), ["bug"]);
    assert.deepStrictEqual(t.calls()[0], [
      "api",
      "repos/rawphp/softfac/labels?per_page=100",
      "--paginate",
    ]);
    // One array per page reads the same as one merged array.
    yield* t.ok(t.github.labelNames());
    assert.deepStrictEqual(yield* t.ok(t.github.labelNames()), ["a", "b"]);
  }),
);

it.effect("labelNames of a repo gh cannot read is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    assert.strictEqual((yield* t.err(t.github.labelNames()))._tag, "GitHubFailed");
  }),
);

it.effect("createLabel sends the name, colour and description as arguments", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.createLabel("factory:ready", "0e8a16", "Approved for the factory"));
    assert.deepStrictEqual(t.calls(), [
      [
        "label",
        "create",
        "factory:ready",
        "--repo",
        REPO,
        "--color",
        "0e8a16",
        "--description",
        "Approved for the factory",
      ],
    ]);
  }),
);

it.effect("a refused createLabel is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "HTTP 403: Resource not accessible"));
    const error = yield* t.err(t.github.createLabel("factory:ready", "0e8a16", "d"));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect("ensureLabels creates only the missing factory labels, in table order", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('[{"name":"bug"},{"name":"factory:ready"}][{"name":"factory:stuck"}]'),
      reply(""),
      reply(""),
      reply(""),
      reply(""),
      reply(""),
    );
    const created = yield* t.ok(t.github.ensureLabels());
    assert.deepStrictEqual(created, ["proposed", "triage", "needs-info", "building", "pr-open"]);
    const calls = t.calls();
    assert.strictEqual(calls.length, 6);
    assert.deepStrictEqual(calls[1], [
      "label",
      "create",
      "factory:proposed",
      "--repo",
      REPO,
      "--color",
      "c5def5",
      "--description",
      "A bot filed it. The factory ignores it until a person sets `factory:ready`.",
    ]);
    assert.deepStrictEqual(
      calls.slice(2).map((call) => call[2]),
      ["factory:triage", "factory:needs-info", "factory:building", "factory:pr-open"],
    );
  }),
);

it.effect("ensureLabels creates nothing when every label exists", () =>
  Effect.gen(function* () {
    const t = setup(reply(JSON.stringify(ALL_LABEL_NAMES.map((name) => ({ name })))));
    assert.deepStrictEqual(yield* t.ok(t.github.ensureLabels()), []);
    assert.strictEqual(t.calls().length, 1);
  }),
);

it.effect("ensureLabels stops at the first failure", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), reply(""), fail(1, "HTTP 403"), reply(""));
    const error = yield* t.err(t.github.ensureLabels());
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.strictEqual(t.calls().length, 3);
  }),
);

it.effect(
  "a NUL byte in an argument is refused before gh starts and never reaches the message",
  () =>
    Effect.gen(function* () {
      const t = setup(reply(""));
      const error = yield* t.err(t.github.postComment(6, "secret\u0000tail"));
      assert.strictEqual(error._tag, "GitHubSpawnError");
      const bytes = new TextEncoder().encode("secret\u0000tail\n\n<!-- softfac -->").length;
      assert.strictEqual(
        error.message,
        `cannot start \`gh issue comment 6 --repo rawphp/softfac --body <${bytes} bytes>\`: argument contains a NUL byte`,
      );
      assert.notInclude(error.message, "secret");
      assert.strictEqual(t.calls().length, 0);
    }),
);

// ---- baseConfig ----

it.effect("baseConfig reads the branch, its tip and the config file at that tip", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"default_branch":"main"}'),
      reply(refReply(BASE_SHA)),
      reply(fileReply("file", "base64", 51, CONFIG_B64)),
    );
    const base = yield* t.ok(t.github.baseConfig());
    assert.deepStrictEqual(base, { branch: "main", tip: BASE_SHA, text: CONFIG_TEXT });
    assert.deepStrictEqual(t.calls(), [
      ["api", "repos/rawphp/softfac"],
      ["api", "repos/rawphp/softfac/git/ref/heads/main"],
      ["api", `repos/rawphp/softfac/contents/${PROJECT_CONFIG_PATH}?ref=${BASE_SHA}`],
    ]);
  }),
);

it.effect("baseConfig passes on a missing file and any other failure", () =>
  Effect.gen(function* () {
    const missing = setup(
      reply('{"default_branch":"main"}'),
      reply(refReply(BASE_SHA)),
      fail(1, "gh: Not Found (HTTP 404)"),
    );
    const notFound = yield* missing.err(missing.github.baseConfig());
    assert.isTrue(isNotFound(notFound));

    const server = setup(
      reply('{"default_branch":"main"}'),
      reply(refReply(BASE_SHA)),
      fail(1, "gh: Server Error (HTTP 502)"),
    );
    const failed = yield* server.err(server.github.baseConfig());
    assert.strictEqual(failed._tag, "GitHubFailed");
    assert.isFalse(isNotFound(failed));

    const first = setup(fail(1, "gh: Not Found (HTTP 404)"));
    assert.strictEqual((yield* first.err(first.github.baseConfig()))._tag, "GitHubFailed");
    assert.strictEqual(first.calls().length, 1);
  }),
);

// ---- listIssues ----

it.effect("listIssues with none", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.deepStrictEqual(issues, { items: [], cut: false });
    assert.deepStrictEqual(t.calls(), [
      [
        "issue",
        "list",
        "--repo",
        REPO,
        "--state",
        "open",
        "--label",
        "factory:ready",
        "--limit",
        "201",
        "--json",
        "number,title,assignees",
      ],
    ]);
  }),
);

it.effect("listIssues with one ignores unknown fields", () =>
  Effect.gen(function* () {
    const t = setup(reply(LIST_ONE));
    const issues = yield* t.ok(t.github.listIssues("needs-info"));
    assert.deepStrictEqual(issues.items, [
      { number: 6, title: "GitHub client", assignees: ["rawphp"] },
    ]);
    assert.strictEqual(t.calls()[0]![7], "factory:needs-info");
  }),
);

it.effect("listIssues with several", () =>
  Effect.gen(function* () {
    const t = setup(reply(LIST_MANY));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.deepStrictEqual(issues.items, [
      { number: 6, title: "GitHub client", assignees: [] },
      { number: 9, title: "Daemon loop", assignees: ["a", "b"] },
    ]);
  }),
);

it.effect("listIssues past the limit returns the first 200 and says it was cut", () =>
  Effect.gen(function* () {
    assert.strictEqual(LIST_LIMIT, 200);
    const t = setup(reply(listingOf(201)));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.isTrue(issues.cut);
    assert.strictEqual(issues.items.length, 200);
    assert.deepStrictEqual(
      issues.items.map((item) => item.number),
      Array.from({ length: 200 }, (_, i) => 201 - i),
    );
    assert.strictEqual(t.calls()[0]![9], "201");
  }),
);

it.effect("listIssues at the limit returns them all and says nothing", () =>
  Effect.gen(function* () {
    const t = setup(reply(listingOf(200)));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.isFalse(issues.cut);
    assert.strictEqual(issues.items.length, 200);
  }),
);

// ---- issue ----

it.effect("issue reads the real shape with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(ISSUE_VIEW));
    const detail = yield* t.ok(t.github.issue(10));
    assert.deepStrictEqual(t.calls(), [issueViewCall]);
    assert.deepStrictEqual(detail, {
      number: 10,
      title: "Build step",
      body: "Build the runner.\n\n- one\n- two",
      labels: ["factory:ready", "phase:1"],
      assignees: ["rawphp"],
      author: "tomkaczocha",
      state: "ready",
      closed: false,
    });
  }),
);

it.effect("issue says when GitHub has it closed and keeps its factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(ISSUE_VIEW.replace('"state":"OPEN"', '"state":"CLOSED"')));
    const detail = yield* t.ok(t.github.issue(10));
    assert.isTrue(detail.closed);
    assert.strictEqual(detail.state, "ready");
  }),
);

it.effect("issue author is null when gh gives null or nothing", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(issueJson([], [], '"b"')),
      reply(ISSUE_VIEW.replace(/"author":\{[^}]*\},/, "")),
    );
    assert.strictEqual((yield* t.ok(t.github.issue(10))).author, null);
    assert.strictEqual((yield* t.ok(t.github.issue(10))).author, null);
  }),
);

it.effect("issue state is null with no factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["phase:1", "bug"], [], '"b"')));
    const detail = yield* t.ok(t.github.issue(10));
    assert.strictEqual(detail.state, null);
    assert.deepStrictEqual(detail.assignees, []);
  }),
);

it.effect("issue state is the one factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["bug", "factory:needs-info"], [], '"b"')));
    assert.strictEqual((yield* t.ok(t.github.issue(10))).state, "needs-info");
  }),
);

it.effect("issue state is null with two factory labels", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready", "factory:building"], [], '"b"')));
    assert.strictEqual((yield* t.ok(t.github.issue(10))).state, null);
  }),
);

it.effect("issue state is null for an unknown factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:bogus"], [], '"b"')));
    assert.strictEqual((yield* t.ok(t.github.issue(10))).state, null);
  }),
);

it.effect("issue state is null with a bogus and a real factory label in either order", () =>
  Effect.gen(function* () {
    for (const labels of [
      ["factory:bogus", "factory:ready"],
      ["factory:ready", "factory:bogus"],
    ]) {
      const t = setup(reply(issueJson(labels, [], '"b"')));
      assert.strictEqual((yield* t.ok(t.github.issue(10))).state, null, labels.join());
    }
  }),
);

it.effect("issue with a null body has an empty body and keeps every assignee", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready"], ["a", "b"], "null")));
    const detail = yield* t.ok(t.github.issue(10));
    assert.strictEqual(detail.body, "");
    assert.deepStrictEqual(detail.assignees, ["a", "b"]);
  }),
);

it.effect("issue errors are typed", () =>
  Effect.gen(function* () {
    const failing = setup(fail(1, "not found"));
    const failed = yield* failing.err(failing.github.issue(10));
    assert.strictEqual(failed._tag, "GitHubFailed");
    assert.strictEqual(failed._tag === "GitHubFailed" ? failed.status : 0, 1);

    const wrong = setup(reply("[]"));
    assert.strictEqual((yield* wrong.err(wrong.github.issue(10)))._tag, "GitHubParse");

    const nullAssignees = setup(reply('{"assignees":null}'));
    assert.strictEqual(
      (yield* nullAssignees.err(nullAssignees.github.issue(10)))._tag,
      "GitHubParse",
    );
  }),
);

it.effect("issue uses the number it is given", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready"], [], '"b"')));
    yield* t.ok(t.github.issue(7));
    assert.deepStrictEqual(t.calls()[0]!.slice(0, 3), ["issue", "view", "7"]);
  }),
);

// ---- setState ----

it.effect("setState from one wrong label", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:ready"])), reply(""));
    yield* t.ok(t.github.setState(6, "triage"));
    assert.deepStrictEqual(t.calls(), [
      viewLabelsCall,
      editCall("--add-label", "factory:triage", "--remove-label", "factory:ready"),
    ]);
  }),
);

it.effect("setState from two factory labels", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:ready", "factory:stuck"])), reply(""));
    yield* t.ok(t.github.setState(6, "building"));
    assert.deepStrictEqual(t.calls(), [
      viewLabelsCall,
      editCall(
        "--add-label",
        "factory:building",
        "--remove-label",
        "factory:ready",
        "--remove-label",
        "factory:stuck",
      ),
    ]);
  }),
);

it.effect("setState removes extras when the target is already present", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:triage", "factory:ready"])), reply(""));
    yield* t.ok(t.github.setState(6, "triage"));
    assert.deepStrictEqual(t.calls(), [
      viewLabelsCall,
      editCall("--remove-label", "factory:ready"),
    ]);
  }),
);

it.effect("setState adds when there is no factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["phase:1"])), reply(""));
    yield* t.ok(t.github.setState(6, "ready"));
    assert.deepStrictEqual(t.calls(), [viewLabelsCall, editCall("--add-label", "factory:ready")]);
  }),
);

it.effect("setState already correct makes no edit", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["phase:1", "factory:building"])));
    yield* t.ok(t.github.setState(6, "building"));
    assert.deepStrictEqual(t.calls(), [viewLabelsCall]);
  }),
);

it.effect("setState leaves non-factory labels alone", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(labelsReply(["phase:1", "factory:ready", "bug", "factory-ish"])),
      reply(""),
    );
    yield* t.ok(t.github.setState(6, "triage"));
    assert.deepStrictEqual(
      t.calls()[1],
      editCall("--add-label", "factory:triage", "--remove-label", "factory:ready"),
    );
  }),
);

it.effect("setState reads the real view shape", () =>
  Effect.gen(function* () {
    const real =
      '{"assignees":[{"login":"rawphp"}],"labels":[{"id":"x","name":"factory:ready","description":"d","color":"0e8a16"},{"name":"phase:1"}]}';
    const t = setup(reply(real), reply(""));
    yield* t.ok(t.github.setState(6, "triage"));
    assert.strictEqual(t.calls().length, 2);
  }),
);

it.effect("setState surfaces a failing edit", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:ready"])), fail(1, "label does not exist"));
    const error = yield* t.err(t.github.setState(6, "triage"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.stderr, "label does not exist");
    assert.deepStrictEqual(error.args.slice(0, 3), ["issue", "edit", "6"]);
    assert.strictEqual(t.calls().length, 2);
  }),
);

// ---- assign, unassign ----

it.effect("unassign removes the user", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.unassign(6, "rawphp"));
    assert.deepStrictEqual(t.calls(), [editCall("--remove-assignee", "rawphp")]);
  }),
);

it.effect("assign adds the user and a failure is an error", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.assign(6, "rawphp"));
    assert.deepStrictEqual(t.calls(), [editCall("--add-assignee", "rawphp")]);

    const failing = setup(fail(1, "HTTP 403\n"));
    assert.strictEqual(
      (yield* failing.err(failing.github.assign(6, "rawphp")))._tag,
      "GitHubFailed",
    );
  }),
);

// ---- error typing ----

it.effect("a non-zero exit carries args, status and stderr", () =>
  Effect.gen(function* () {
    const t = setup(fail(4, "HTTP 404: Not Found\n"));
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.deepStrictEqual(error.args.slice(0, 2), ["issue", "list"]);
    assert.strictEqual(error.status, 4);
    assert.strictEqual(error.stderr, "HTTP 404: Not Found\n");
    assert.include(error.message, "gh issue list --repo rawphp/softfac");
    assert.include(error.message, "status 4");
    assert.include(error.message, "HTTP 404: Not Found");
  }),
);

it("only a failure with HTTP 404 in stderr is not found", () => {
  const args = ["api", "repos/rawphp/softfac/branches/x"];
  const failed = (stderr: string) => new GitHubFailed({ args, status: 1, stderr });
  assert.isTrue(isNotFound(failed("gh: Not Found (HTTP 404)")));
  assert.isTrue(isNotFound(failed("HTTP 404: Not Found\n")));
  const others: ReadonlyArray<GitHubError> = [
    failed("gh: Server Error (HTTP 500)"),
    failed("gh: Forbidden (HTTP 403)"),
    new GitHubTimedOut({ args, seconds: 30 }),
    new GitHubSpawnError({ args, cause: new Error("HTTP 404") }),
    new GitHubOutputTooLarge({ args, limit: 1024 }),
    new GitHubParse({ args, expected: "HTTP 404" }),
    new GitHubInvalidArgument({ argument: "HTTP 404", expected: "x" }),
    new GitHubRateLimited({ args, stderr: "HTTP 404 API rate limit" }),
  ];
  for (const other of others) assert.isFalse(isNotFound(other), other._tag);
});

it.effect("a signal-killed gh is a failure with status -1", () =>
  Effect.gen(function* () {
    const t = setup(signalKilled());
    const error = yield* t.err(t.github.unassign(6, "rawphp"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.status, -1);
    assert.include(error.message, "status -1");
  }),
);

it.effect("malformed JSON is a parse error carrying the args", () =>
  Effect.gen(function* () {
    const t = setup(reply("not json"));
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubParse");
    if (error._tag !== "GitHubParse") return;
    assert.deepStrictEqual(error.args, t.calls()[0]);
    assert.include(error.expected, "JSON array of issues");
    assert.include(error.message, "unexpected output");
    assert.include(error.message, "gh issue list --repo rawphp/softfac");

    const labels = setup(reply('{"labels":"nope"}'));
    const labelsError = yield* labels.err(labels.github.setState(6, "ready"));
    assert.strictEqual(labelsError._tag, "GitHubParse");
    if (labelsError._tag !== "GitHubParse") return;
    assert.deepStrictEqual(labelsError.args, viewLabelsCall);
    assert.strictEqual(labels.calls().length, 1);
  }),
);

it.effect("a spawn failure is a spawn error carrying the args", () =>
  Effect.gen(function* () {
    const t = setup(spawnError());
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubSpawnError");
    if (error._tag !== "GitHubSpawnError") return;
    assert.deepStrictEqual(error.args, t.calls()[0]);
    assert.include(error.message, "gh issue list --repo rawphp/softfac");
    assert.include(error.message, "gh not found");

    const unassign = setup(spawnError());
    const unassignError = yield* unassign.err(unassign.github.unassign(6, "rawphp"));
    assert.strictEqual(unassignError._tag, "GitHubSpawnError");
    if (unassignError._tag !== "GitHubSpawnError") return;
    assert.deepStrictEqual(unassignError.args, editCall("--remove-assignee", "rawphp"));
  }),
);

it.effect("a gh the shell cannot find or run is a spawn error, not a failed call", () =>
  Effect.gen(function* () {
    for (const [status, stderr] of [
      [127, "sh: gh: not found\n"],
      [126, "sh: /usr/local/bin/gh: Permission denied\n"],
    ] as const) {
      const t = setup(fail(status, stderr));
      const error = yield* t.err(t.github.listIssues("ready"));
      assert.strictEqual(error._tag, "GitHubSpawnError", stderr);
      if (error._tag !== "GitHubSpawnError") return;
      assert.deepStrictEqual(error.args, t.calls()[0]);
      assert.include(error.message, stderr.trim());
    }
    const other = setup(fail(2, "unknown flag"));
    assert.strictEqual((yield* other.err(other.github.listIssues("ready")))._tag, "GitHubFailed");
  }),
);

it.effect("a timed out gh is a timeout error", () =>
  Effect.gen(function* () {
    const t = setup(timedOut());
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubTimedOut");
    if (error._tag !== "GitHubTimedOut") return;
    assert.strictEqual(error.seconds, 60);
    assert.include(error.message, "timed out after 60 s");
    assert.match(error.message, /^`gh issue list .*` timed out after 60 s$/);
  }),
);

it.effect("output past the cap is an error, never a truncation", () =>
  Effect.gen(function* () {
    const t = setup(truncated());
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubOutputTooLarge");
    if (error._tag !== "GitHubOutputTooLarge") return;
    assert.strictEqual(error.limit, 8 * 1024 * 1024);
    assert.include(error.message, `printed more than ${8 * 1024 * 1024} bytes`);
    assert.match(error.message, /^`gh issue list .*` printed more than/);
  }),
);

// ---- rate limit ----

it.effect("only the rate limit is read as a rate limit", () =>
  Effect.gen(function* () {
    for (const stderr of [
      "GraphQL: API rate limit already exceeded for user ID 1.",
      "gh: API rate limit exceeded (HTTP 403)",
      "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      "gh: Too Many Requests (HTTP 429)",
    ]) {
      const t = setup(fail(1, stderr));
      const error = yield* t.err(t.github.listIssues("ready"));
      assert.strictEqual(error._tag, "GitHubRateLimited");
      if (error._tag !== "GitHubRateLimited") return;
      assert.strictEqual(error.stderr, stderr);
      assert.include(error.args, "list");
      assert.include(error.message, "gh issue list --repo rawphp/softfac");
      assert.include(error.message, `hit GitHub's rate limit: ${stderr}`);
    }
    const other = setup(fail(1, "HTTP 404: Not Found"));
    assert.strictEqual((yield* other.err(other.github.listIssues("ready")))._tag, "GitHubFailed");
  }),
);

it.effect("a success that mentions the rate limit is not an error", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]", "API rate limit"));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.deepStrictEqual(issues, { items: [], cut: false });
  }),
);

// ---- postComment ----

it.effect("postComment appends the marker", () =>
  Effect.gen(function* () {
    const t = setup(reply("https://github.com/rawphp/softfac/issues/6#issuecomment-1\n"));
    yield* t.ok(t.github.postComment(6, "hello"));
    assert.deepStrictEqual(t.calls(), [commentCall("6", "hello\n\n<!-- softfac -->")]);
    assert.strictEqual(MARKER, "<!-- softfac -->");
    assert.strictEqual(STATUS_MARKER, "<!-- softfac:status -->");
  }),
);

it.effect("untrusted bodies arrive as one unmodified argument", () =>
  Effect.gen(function* () {
    const nasty = "$(rm -rf ~) `id` \"q\" 'q' ; | && > /tmp/x\nsecond line\n--add-label evil";
    const expected = `${nasty}\n\n${MARKER}`;
    const status = `${nasty}\n\n${STATUS_MARKER}`;

    const post = setup(reply(""));
    yield* post.ok(post.github.postComment(6, nasty));
    assert.deepStrictEqual(post.calls(), [commentCall("6", expected)]);

    const create = setup(reply("[]"), reply(""));
    yield* create.ok(create.github.upsertStatusComment(6, "rawphp", nasty));
    assert.deepStrictEqual(create.calls()[1], commentCall("6", status));

    const patch = setup(
      reply('[{"id":77,"user":{"login":"rawphp"},"body":"old\\n\\n<!-- softfac:status -->"}]'),
      reply(""),
    );
    yield* patch.ok(patch.github.upsertStatusComment(6, "rawphp", nasty));
    assert.deepStrictEqual(patch.calls()[1], patchCall("77", status));
  }),
);

it.effect("postComment errors carry the status and stderr", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "issue is locked"));
    const error = yield* t.err(t.github.postComment(6, "x"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.status, 1);
    assert.strictEqual(error.stderr, "issue is locked");
    assert.include(error.message, "issue is locked");
  }),
);

// ---- upsertStatusComment ----

it.effect("the status comment is created when absent", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":1,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"a person\'s comment"},{"id":2,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:14:16Z","body":"questions\\n\\n<!-- softfac -->"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "state: building"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "state: building\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the status comment is patched by id when present", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":1,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"hi"},{"id":5978910929,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:14:16Z","body":"state: triage\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "state: building"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      patchCall("5978910929", "state: building\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the status comment is never created twice", () =>
  Effect.gen(function* () {
    const created = `[{"id":42,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"one\\n\\n${STATUS_MARKER}"}]`;
    const t = setup(reply("[]"), reply(""), reply(created), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "one"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "two"));
    const calls = t.calls();
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(
      calls.filter((call) => call[0] === "issue" && call[1] === "comment").length,
      1,
    );
    assert.deepStrictEqual(calls[3]!.slice(0, 4), [
      "api",
      "-X",
      "PATCH",
      "repos/rawphp/softfac/issues/comments/42",
    ]);
  }),
);

it.effect("a status marker posted by someone else is not adopted", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"stranger"},"created_at":"2026-10-04T10:13:16Z","body":"gotcha\\n\\n<!-- softfac:status -->"},{"id":11,"user":null,"created_at":"2026-10-04T10:14:16Z","body":"ghost\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "real status"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "real status\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("a status marker in the middle of the factory's comment is not adopted", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"quoting <!-- softfac:status --> and more text"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "s\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the factory's own status comment is found despite case and trailing whitespace", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"stranger"},"body":"fake\\n\\n<!-- softfac:status -->"},{"id":12,"user":{"login":"RawPhp"},"body":"state: triage\\n\\n<!-- softfac:status -->\\n\\n"}]';
    const t = setup(reply(listing), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.deepStrictEqual(t.calls()[1], patchCall("12", "s\n\n<!-- softfac:status -->"));
  }),
);

it.effect("the status comment user match is exact, not a prefix", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"rawphp-bot"},"body":"a\\n\\n<!-- softfac:status -->"},{"id":11,"user":{"login":"raw"},"body":"b\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "s\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the status comment is found on a later page", () =>
  Effect.gen(function* () {
    // `gh api --paginate` may print each page as its own array.
    const pages =
      '[{"id":1,"body":"a"}][{"id":2,"body":"b"},{"id":3,"user":{"login":"rawphp"},"body":"state\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(pages), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(t.calls()[1]![3], "repos/rawphp/softfac/issues/comments/3");
  }),
);

it.effect("pages split correctly around brackets and quotes inside strings", () =>
  Effect.gen(function* () {
    const pages =
      '[{"id":1,"user":{"login":"x"},"body":"] [ } \\" {"}]\n[{"id":3,"user":{"login":"rawphp"},"body":"s\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(pages), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(t.calls()[1]![3], "repos/rawphp/softfac/issues/comments/3");
  }),
);

it.effect("status comment errors", () =>
  Effect.gen(function* () {
    const spawn = setup(spawnError());
    assert.strictEqual(
      (yield* spawn.err(spawn.github.upsertStatusComment(6, "rawphp", "x")))._tag,
      "GitHubSpawnError",
    );

    const oops = setup(reply("oops"));
    assert.strictEqual(
      (yield* oops.err(oops.github.upsertStatusComment(6, "rawphp", "x")))._tag,
      "GitHubParse",
    );
    assert.strictEqual(oops.calls().length, 1);

    const empty = setup(reply(""));
    const emptyError = yield* empty.err(empty.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(emptyError._tag, "GitHubParse");
    if (emptyError._tag !== "GitHubParse") return;
    assert.deepStrictEqual(emptyError.args, listCommentsCall);
    assert.include(emptyError.expected, "output was empty");

    const failing = setup(reply("[]"), fail(1, "rate limited"));
    const failed = yield* failing.err(failing.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(failed._tag, "GitHubFailed");
    if (failed._tag !== "GitHubFailed") return;
    assert.strictEqual(failed.stderr, "rate limited");
  }),
);

it.effect("the status comment surfaces a failing patch", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":12,"user":{"login":"rawphp"},"body":"state: triage\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), fail(1, "validation failed"));
    const error = yield* t.err(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.stderr, "validation failed");
    assert.deepStrictEqual(error.args.slice(0, 3), ["api", "-X", "PATCH"]);
    assert.strictEqual(t.calls().length, 2);
  }),
);

// ---- error text ----

it.effect("error text hides comment bodies but the error keeps them", () =>
  Effect.gen(function* () {
    // "hello\nworld" + "\n\n" + the 16-byte marker = 29 bytes.
    const t = setup(fail(1, "boom"));
    const error = yield* t.err(t.github.postComment(6, "hello\nworld"));
    assert.strictEqual(
      error.message,
      "`gh issue comment 6 --repo rawphp/softfac --body <29 bytes>` exited with status 1: boom",
    );
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.args.at(-1), "hello\nworld\n\n<!-- softfac -->");

    // Counted in bytes, not characters: "héllo ✓" is 7 chars and 10 bytes, plus 18.
    const utf8 = setup(fail(1, "boom"));
    const shown = (yield* utf8.err(utf8.github.postComment(6, "héllo ✓"))).message;
    assert.include(shown, "--body <28 bytes>");
    assert.notInclude(shown, "llo");
  }),
);

it.effect("error text hides raw field bodies", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":77,"user":{"login":"rawphp"},"body":"old\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), fail(1, "gone"));
    const shown = (yield* t.err(t.github.upsertStatusComment(6, "rawphp", "private status")))
      .message;
    assert.include(shown, "repos/rawphp/softfac/issues/comments/77 -f body=<39 bytes>");
    assert.notInclude(shown, "private");
  }),
);

it("error text escapes newlines in other arguments", () => {
  assert.strictEqual(
    new GitHubParse({ args: ["issue", "edit", "a\nb\r\nc"], expected: "x" }).message,
    "`gh issue edit a\\nb\\r\\nc` returned unexpected output: x",
  );
  assert.strictEqual(
    new GitHubInvalidArgument({ argument: "a\nb", expected: "a plain file path" }).message,
    'refused "a\\nb" before calling gh: expected a plain file path',
  );
  assert.strictEqual(
    new GitHubSpawnError({ args: ["--body"], cause: new Error("nope") }).message,
    "cannot start `gh --body`: nope",
  );
});

// ---- pullRequest ----

const HEAD_SHA = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
const PR_VIEW =
  '{"baseRefName":"main","headRefName":"t3code/2bb65018","headRefOid":"4f1c2d3e4a5b60718293a4b5c6d7e8f901234567","isCrossRepository":false,"isDraft":true,"number":2,"state":"OPEN"}';
const prView = (state: string, draft: boolean) =>
  `{"baseRefName":"main","headRefName":"x","headRefOid":"${HEAD_SHA}","isCrossRepository":false,"isDraft":${draft},"number":9,"state":"${state}"}`;
const prViewCall = (number: string) => [
  "pr",
  "view",
  number,
  "--repo",
  REPO,
  "--json",
  "number,isDraft,state,headRefName,isCrossRepository,baseRefName,headRefOid",
];

it.effect("pullRequest reads the real shape with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(PR_VIEW));
    const pr = yield* t.ok(t.github.pullRequest(2));
    assert.deepStrictEqual(t.calls(), [prViewCall("2")]);
    assert.deepStrictEqual(pr, {
      number: 2,
      isDraft: true,
      open: true,
      merged: false,
      headRef: "t3code/2bb65018",
      crossRepository: false,
      baseRef: "main",
      headSha: HEAD_SHA,
    });
  }),
);

it.effect("pullRequest says when it is merged and is then not open", () =>
  Effect.gen(function* () {
    const merged = setup(reply(PR_VIEW.replace('"state":"OPEN"', '"state":"MERGED"')));
    const pr = yield* merged.ok(merged.github.pullRequest(2));
    assert.isTrue(pr?.merged);
    assert.isFalse(pr?.open);
    const closed = setup(reply(PR_VIEW.replace('"state":"OPEN"', '"state":"CLOSED"')));
    const other = yield* closed.ok(closed.github.pullRequest(2));
    assert.isFalse(other?.merged);
    assert.isFalse(other?.open);
  }),
);

it.effect("pullRequest from a fork and into another base says so", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `{"baseRefName":"release/1.0","headRefName":"t3code/x","headRefOid":"${HEAD_SHA}","isCrossRepository":true,"isDraft":true,"number":4,"state":"OPEN"}`,
      ),
    );
    const pr = yield* t.ok(t.github.pullRequest(4));
    assert.isTrue(pr?.crossRepository);
    assert.strictEqual(pr?.baseRef, "release/1.0");
    assert.strictEqual(pr?.headRef, "t3code/x");
  }),
);

it.effect("a pullRequest view without the fork or base fields is a parse error", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `{"headRefName":"x","headRefOid":"${HEAD_SHA}","isDraft":true,"number":3,"state":"OPEN"}`,
      ),
    );
    const error = yield* t.err(t.github.pullRequest(3));
    assert.strictEqual(error._tag, "GitHubParse");
  }),
);

it.effect("a pullRequest view without the head commit is a parse error", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        '{"baseRefName":"main","headRefName":"x","isCrossRepository":false,"isDraft":true,"number":3,"state":"OPEN"}',
      ),
    );
    const error = yield* t.err(t.github.pullRequest(3));
    assert.strictEqual(error._tag, "GitHubParse");
  }),
);

it.effect("pullRequest reads the head commit as given", () =>
  Effect.gen(function* () {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const t = setup(
      reply(
        `{"baseRefName":"main","headRefName":"x","headRefOid":"${sha}","isCrossRepository":false,"isDraft":true,"number":3,"state":"OPEN"}`,
      ),
    );
    assert.strictEqual((yield* t.ok(t.github.pullRequest(3)))?.headSha, sha);
  }),
);

it.effect("a pullRequest whose head commit is not a full id is a parse error", () =>
  Effect.gen(function* () {
    for (const sha of ["", "4f1c2d3", `${HEAD_SHA}0`, HEAD_SHA.replaceAll("4", "g")]) {
      const t = setup(reply(PR_VIEW.replace(HEAD_SHA, sha)));
      const error = yield* t.err(t.github.pullRequest(2));
      assert.strictEqual(error._tag, "GitHubParse", sha);
    }
  }),
);

it.effect("pullRequest merged and closed are not open", () =>
  Effect.gen(function* () {
    for (const state of ["MERGED", "CLOSED"]) {
      const t = setup(reply(prView(state, false)));
      const pr = yield* t.ok(t.github.pullRequest(9));
      assert.isFalse(pr?.open, state);
      assert.isFalse(pr?.isDraft, state);
    }
  }),
);

it.effect("a pullRequest that does not exist is null", () =>
  Effect.gen(function* () {
    for (const stderr of [
      "GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)\n",
      "graphql: could not resolve to a pullrequest with the number of 999.",
      "GRAPHQL: COULD NOT RESOLVE TO A PULLREQUEST",
    ]) {
      const t = setup(fail(1, stderr));
      assert.isNull(yield* t.ok(t.github.pullRequest(999)), stderr);
    }
  }),
);

it.effect("any other pullRequest failure stays an error", () =>
  Effect.gen(function* () {
    for (const stderr of [
      "HTTP 502: Bad Gateway",
      "Could not resolve host: api.github.com",
      "Could not resolve to an Issue with the number of 5.",
      "",
    ]) {
      const t = setup(fail(1, stderr));
      const error = yield* t.err(t.github.pullRequest(999));
      assert.strictEqual(error._tag, "GitHubFailed", stderr);
      if (error._tag === "GitHubFailed") assert.strictEqual(error.status, 1, stderr);
    }
    const t = setup(spawnError());
    const error = yield* t.err(t.github.pullRequest(999));
    assert.strictEqual(error._tag, "GitHubSpawnError");
  }),
);

it.effect("pullRequest errors are typed", () =>
  Effect.gen(function* () {
    const failed = setup(fail(1, "no pull requests found"));
    assert.strictEqual((yield* failed.err(failed.github.pullRequest(2)))._tag, "GitHubFailed");
    const parse = setup(reply("{}"));
    assert.strictEqual((yield* parse.err(parse.github.pullRequest(2)))._tag, "GitHubParse");
  }),
);

it.effect("issue and pullRequest calls use the number they are given", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready"], [], '"b"')), reply(prView("OPEN", true)));
    yield* t.ok(t.github.issue(7));
    yield* t.ok(t.github.pullRequest(3));
    assert.deepStrictEqual(t.calls(), [
      [
        "issue",
        "view",
        "7",
        "--repo",
        REPO,
        "--json",
        "number,title,body,labels,assignees,state,author",
      ],
      prViewCall("3"),
    ]);
  }),
);

// ---- markPrReady, markPrDraft, commentOnPr ----

const readyCall = ["pr", "ready", "9", "--repo", REPO];
const undoCall = [...readyCall, "--undo"];

it.effect("markPrReady runs gh pr ready", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.markPrReady(9));
    assert.deepStrictEqual(t.calls(), [readyCall]);

    const failed = setup(fail(1, "not a draft"));
    const error = yield* failed.err(failed.github.markPrReady(9));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect("markPrReady on a PR that is already ready is success", () =>
  Effect.gen(function* () {
    // What `gh` 2.102 does: it warns on stderr and exits 0.
    const stderr = '! Pull request rawphp/softfac#9 is already "ready for review"\n';
    const warned = setup(reply("", stderr));
    yield* warned.ok(warned.github.markPrReady(9));

    // Should a version exit non-zero for it, the PR is still ready: that is success too.
    const failed = setup(fail(1, stderr));
    yield* failed.ok(failed.github.markPrReady(9));
    assert.deepStrictEqual(failed.calls(), [readyCall]);
  }),
);

it.effect("markPrReady still fails for a closed PR or any other error", () =>
  Effect.gen(function* () {
    for (const stderr of [
      '! Pull request rawphp/softfac#9 is closed. Only draft pull requests can be marked as "ready for review"\n',
      "GraphQL: Resource not accessible by integration\n",
      "",
    ]) {
      const t = setup(fail(1, stderr));
      const error = yield* t.err(t.github.markPrReady(9));
      assert.strictEqual(error._tag, "GitHubFailed", stderr);
    }
  }),
);

it.effect("markPrDraft runs gh pr ready --undo", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.markPrDraft(9));
    assert.deepStrictEqual(t.calls(), [undoCall]);

    const failed = setup(fail(1, "GraphQL: Resource not accessible by integration\n"));
    const error = yield* failed.err(failed.github.markPrDraft(9));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect("markPrDraft on a PR that is already a draft is success", () =>
  Effect.gen(function* () {
    // What `gh` does for `--undo` on a draft: it warns on stderr and exits 0. Should a version
    // exit non-zero for it, the PR is still a draft: that is success too.
    const stderr = '! Pull request rawphp/softfac#9 is already "in draft"\n';
    const warned = setup(reply("", stderr));
    yield* warned.ok(warned.github.markPrDraft(9));

    const failed = setup(fail(1, stderr));
    yield* failed.ok(failed.github.markPrDraft(9));
    assert.deepStrictEqual(failed.calls(), [undoCall]);
  }),
);

it.effect("markPrDraft on a PR that is closed or merged is done whatever gh says", () =>
  Effect.gen(function* () {
    // The words of the refusal are not relied on: the pull request's state decides.
    for (const state of ["CLOSED", "MERGED"]) {
      for (const stderr of [
        "! Pull request rawphp/softfac#9 is closed. Only open pull requests can be converted to draft\n",
        "GraphQL: Something unforeseen\n",
      ]) {
        const t = setup(fail(1, stderr), reply(prView(state, false)));
        yield* t.ok(t.github.markPrDraft(9));
        assert.deepStrictEqual(t.calls(), [undoCall, prViewCall("9")], `${state}: ${stderr}`);
      }
    }
  }),
);

it.effect("markPrDraft reads the state after any failure, not only a non-zero exit", () =>
  Effect.gen(function* () {
    // A timed out, rate limited or oversized undo on a PR that is closed by now is done too.
    for (const first of [
      timedOut(),
      fail(1, "gh: API rate limit exceeded (HTTP 403)"),
      truncated(),
    ]) {
      const t = setup(first, reply(prView("CLOSED", false)));
      yield* t.ok(t.github.markPrDraft(9));
      assert.deepStrictEqual(t.calls(), [undoCall, prViewCall("9")]);
    }
    // On one that is still open the original error comes back, whatever kind it was.
    const open = setup(timedOut(), reply(prView("OPEN", false)));
    const error = yield* open.err(open.github.markPrDraft(9));
    assert.strictEqual(error._tag, "GitHubTimedOut");
  }),
);

it.effect("markPrDraft that fails on an open PR or cannot read it is the original error", () =>
  Effect.gen(function* () {
    // Open: the failure is real.
    const open = setup(
      fail(1, "GraphQL: Resource not accessible by integration\n"),
      reply(prView("OPEN", false)),
    );
    const onOpen = yield* open.err(open.github.markPrDraft(9));
    assert.strictEqual(onOpen._tag, "GitHubFailed");
    if (onOpen._tag === "GitHubFailed") assert.include(onOpen.stderr, "not accessible");

    // The read fails too: still the original error.
    const unread = setup(
      fail(1, "GraphQL: Resource not accessible by integration\n"),
      fail(1, "HTTP 502: Bad Gateway"),
    );
    const onUnread = yield* unread.err(unread.github.markPrDraft(9));
    assert.strictEqual(onUnread._tag, "GitHubFailed");
    if (onUnread._tag === "GitHubFailed") assert.include(onUnread.stderr, "not accessible");

    // One that is gone: nothing to draft either.
    const gone = setup(
      fail(1, "boom"),
      fail(1, "GraphQL: Could not resolve to a PullRequest with the number of 9."),
    );
    const onGone = yield* gone.err(gone.github.markPrDraft(9));
    assert.strictEqual(onGone._tag, "GitHubFailed");
    if (onGone._tag === "GitHubFailed") assert.include(onGone.stderr, "boom");
  }),
);

it.effect("commentOnPr appends the marker", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.commentOnPr(9, "gate passed"));
    assert.deepStrictEqual(t.calls(), [
      ["pr", "comment", "9", "--repo", REPO, "--body", "gate passed\n\n<!-- softfac -->"],
    ]);

    const failed = setup(spawnError());
    const error = yield* failed.err(failed.github.commentOnPr(9, "x"));
    assert.strictEqual(error._tag, "GitHubSpawnError");
  }),
);

// ---- compare ----

const compareCall = (range: string) => [
  "api",
  `repos/rawphp/softfac/compare/${range}?per_page=1`,
  "--jq",
  ".status",
];

it.effect("compare asks for the status of the two refs with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply("ahead\n"));
    assert.strictEqual(yield* t.ok(t.github.compare("main", BASE_SHA)), "ahead");
    assert.deepStrictEqual(t.calls(), [compareCall(`main...${BASE_SHA}`)]);
  }),
);

it.effect("compare reads each status GitHub gives", () =>
  Effect.gen(function* () {
    for (const [text, relation] of [
      ["ahead", "ahead"],
      ["behind\n", "behind"],
      ["identical\n", "identical"],
      ["diverged", "diverged"],
    ] as const) {
      const t = setup(reply(text));
      assert.strictEqual(yield* t.ok(t.github.compare("main", BASE_SHA)), relation, text);
    }
  }),
);

it.effect("compare of a commit GitHub does not know is null", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: No commit found for SHA: 9f8e7d6 (HTTP 404)"));
    assert.isNull(yield* t.ok(t.github.compare("main", BASE_SHA)));
  }),
);

it.effect("compare keeps every other failure an error", () =>
  Effect.gen(function* () {
    for (const answer of [
      fail(1, "gh: API rate limit exceeded (HTTP 403)"),
      fail(1, "gh: Server Error (HTTP 500)"),
      fail(4, "gh: To get started with GitHub CLI, please run: gh auth login"),
      spawnError(),
    ]) {
      const t = setup(answer);
      yield* t.err(t.github.compare("main", BASE_SHA));
    }
  }),
);

it.effect("compare refuses a status it does not know", () =>
  Effect.gen(function* () {
    for (const answer of ["", "sideways", '"ahead"', "null", "{}"]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.compare("main", BASE_SHA));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("compare encodes a branch and refuses a ref that could leave the compare path", () =>
  Effect.gen(function* () {
    const t = setup(reply("behind"));
    yield* t.ok(t.github.compare("release/1.0", BASE_SHA));
    assert.strictEqual(
      t.calls()[0]![1],
      `repos/rawphp/softfac/compare/release/1.0...${BASE_SHA}?per_page=1`,
    );
    for (const [base, head] of [
      ["", BASE_SHA],
      ["main", ""],
      ["..", BASE_SHA],
      ["a..b", BASE_SHA],
      ["main", "../x"],
      ["main", "a...b"],
      ["a/../b", BASE_SHA],
    ]) {
      const refused = setup(reply("ahead"));
      const error = yield* refused.err(refused.github.compare(base!, head!));
      assert.strictEqual(error._tag, "GitHubInvalidArgument", `${base} ${head}`);
      assert.deepStrictEqual(refused.calls(), [], `${base} ${head}`);
    }
  }),
);

// ---- checks ----

const run = (name: string, status: string, conclusion: string | null) => ({
  id: 1,
  name,
  status,
  conclusion,
  html_url: `https://github.com/rawphp/softfac/actions/runs/1/job/${name}`,
  app: { slug: "github-actions" },
});
const page = (runs: ReadonlyArray<unknown>) => JSON.stringify(runs);
const checksCall = [
  "api",
  `repos/rawphp/softfac/commits/${BASE_SHA}/check-runs?per_page=100&filter=latest`,
  "--paginate",
  "--jq",
  "[.check_runs[] | {name, status, conclusion, html_url}]",
];

it.effect("checks reads the check runs of the commit with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(page([run("gate", "completed", "success")])));
    const checks = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.deepStrictEqual(t.calls(), [checksCall]);
    assert.deepStrictEqual(checks, [
      {
        name: "gate",
        state: "passed",
        conclusion: "success",
        url: "https://github.com/rawphp/softfac/actions/runs/1/job/gate",
      },
    ]);
  }),
);

it.effect("checks answers for each name asked in the order asked and ignores other runs", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        page([
          run("lint", "completed", "success"),
          run("other", "completed", "failure"),
          run("gate", "completed", "success"),
        ]),
      ),
    );
    const checks = yield* t.ok(t.github.checks(BASE_SHA, ["gate", "lint"]));
    assert.deepStrictEqual(
      checks.map((c) => [c.name, c.state]),
      [
        ["gate", "passed"],
        ["lint", "passed"],
      ],
    );
  }),
);

it.effect("a completed run passes on success and neutral and fails on anything else", () =>
  Effect.gen(function* () {
    for (const conclusion of ["success", "neutral"]) {
      const t = setup(reply(page([run("gate", "completed", conclusion)])));
      const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(got[0]!.state, "passed", conclusion);
    }
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
      "something_new",
    ]) {
      const t = setup(reply(page([run("gate", "completed", conclusion)])));
      const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(got[0]!.state, "failed", conclusion);
      assert.strictEqual(got[0]!.conclusion, conclusion);
    }
    // Completed with no conclusion is not a pass.
    const t = setup(reply(page([run("gate", "completed", null)])));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(got[0]!.state, "failed");
    assert.strictEqual(got[0]!.conclusion, "completed");
  }),
);

it.effect("a run that has not completed is pending", () =>
  Effect.gen(function* () {
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const t = setup(reply(page([run("gate", status, null)])));
      const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(got[0]!.state, "pending", status);
      assert.strictEqual(got[0]!.conclusion, status);
    }
  }),
);

it.effect("a check with no run is missing and not pending", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.deepStrictEqual(got, [{ name: "gate", state: "missing", conclusion: "", url: null }]);
  }),
);

it.effect("a name that is not exactly the run's is missing", () =>
  Effect.gen(function* () {
    const t = setup(reply(page([run("Gate", "completed", "success")])));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(got[0]!.state, "missing");
  }),
);

it.effect("a skipped run is not a result so the check stays missing", () =>
  Effect.gen(function* () {
    // The factory's pull request is a draft until the checks pass, and a job guarded by
    // "not a draft" is skipped on it: nothing ran, so nothing passed.
    const t = setup(reply(page([run("gate", "completed", "skipped")])));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(got[0]!.state, "missing");
    assert.strictEqual(got[0]!.conclusion, "skipped");
  }),
);

it.effect("several runs of one name fail before they pend and pend before they pass", () =>
  Effect.gen(function* () {
    type Run = readonly [string, string | null];
    const state = (a: Run, b: Run) =>
      Effect.gen(function* () {
        const t = setup(reply(page([run("gate", a[0], a[1]), run("gate", b[0], b[1])])));
        return (yield* t.ok(t.github.checks(BASE_SHA, ["gate"])))[0]!.state;
      });
    assert.strictEqual(yield* state(["completed", "success"], ["completed", "failure"]), "failed");
    // The conclusion and the link are the deciding run's, whichever came first.
    const mixed = setup(
      reply(
        page([
          run("gate", "completed", "success"),
          { ...run("gate", "completed", "failure"), html_url: "https://github.com/x/y/runs/2" },
        ]),
      ),
    );
    assert.deepStrictEqual(yield* mixed.ok(mixed.github.checks(BASE_SHA, ["gate"])), [
      {
        name: "gate",
        state: "failed",
        conclusion: "failure",
        url: "https://github.com/x/y/runs/2",
      },
    ]);
    assert.strictEqual(yield* state(["in_progress", null], ["completed", "success"]), "pending");
    assert.strictEqual(yield* state(["completed", "success"], ["completed", "neutral"]), "passed");
    // A failure is not hidden by a run that is going again, in either order.
    assert.strictEqual(yield* state(["completed", "failure"], ["in_progress", null]), "failed");
    assert.strictEqual(yield* state(["in_progress", null], ["completed", "failure"]), "failed");
    // One skipped run among passing ones is not every run passing.
    assert.strictEqual(yield* state(["completed", "success"], ["completed", "skipped"]), "missing");
    assert.strictEqual(yield* state(["completed", "skipped"], ["completed", "success"]), "missing");
    // A skipped run does not hide one that is still going, or one that failed.
    assert.strictEqual(yield* state(["completed", "skipped"], ["in_progress", null]), "pending");
    assert.strictEqual(yield* state(["in_progress", null], ["completed", "skipped"]), "pending");
    assert.strictEqual(yield* state(["completed", "skipped"], ["completed", "failure"]), "failed");
    assert.strictEqual(yield* state(["completed", "failure"], ["completed", "skipped"]), "failed");
  }),
);

it.effect("of several runs that decide alike, the first one listed is reported", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        page([
          { ...run("gate", "completed", "failure"), html_url: "https://github.com/x/y/runs/1" },
          { ...run("gate", "completed", "cancelled"), html_url: "https://github.com/x/y/runs/2" },
        ]),
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.checks(BASE_SHA, ["gate"])), [
      {
        name: "gate",
        state: "failed",
        conclusion: "failure",
        url: "https://github.com/x/y/runs/1",
      },
    ]);
  }),
);

it.effect("checks reads every page", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `${page([run("gate", "completed", "success")])}\n${page([run("lint", "in_progress", null)])}`,
      ),
    );
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate", "lint"]));
    assert.strictEqual(got[0]!.state, "passed");
    assert.strictEqual(got[1]!.state, "pending");
  }),
);

it.effect("checks keeps a details link only when it is a GitHub one", () =>
  Effect.gen(function* () {
    for (const url of [
      "https://evil.example/x",
      "https://github.com.evil.example/x",
      "http://github.com/x",
    ]) {
      const odd = setup(reply(page([{ ...run("gate", "completed", "failure"), html_url: url }])));
      assert.isNull((yield* odd.ok(odd.github.checks(BASE_SHA, ["gate"])))[0]!.url, url);
    }
    const none = setup(reply(page([{ ...run("gate", "completed", "failure"), html_url: null }])));
    assert.isNull((yield* none.ok(none.github.checks(BASE_SHA, ["gate"])))[0]!.url);
  }),
);

it.effect("checks refuses a commit that is not a full id before any call", () =>
  Effect.gen(function* () {
    for (const sha of ["", "main", "9f8e7d6", "../x", BASE_SHA.replaceAll("9", "g")]) {
      const t = setup(reply("[]"));
      const error = yield* t.err(t.github.checks(sha, ["gate"]));
      assert.strictEqual(error._tag, "GitHubInvalidArgument", sha);
      assert.deepStrictEqual(t.calls(), [], sha);
    }
  }),
);

it.effect("checks refuses an answer that is not a list of runs", () =>
  Effect.gen(function* () {
    for (const answer of ["{}", "not json", '[{"name":"gate"}]']) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("checks that gh cannot read is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    const error = yield* t.err(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

// ---- blockers: ported from softfac's github.rs ----

const blockedByCall = (issue: string) => [
  "api",
  `repos/rawphp/softfac/issues/${issue}/dependencies/blocked_by`,
  "--paginate",
];
const blockerRow = (number: number, state: string, repo: string) =>
  `{"id":${number},"number":${number},"state":"${state}","title":"t","repository_url":"https://api.github.com/repos/${repo}","labels":[]}`;
const openBlocker = (number: number, repo: string): Blocker => ({ repo, number });

it.effect("an issue with no blockers has no open blockers", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"));
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), []);
    assert.deepStrictEqual(t.calls(), [blockedByCall("14")]);
  }),
);

it.effect("a closed blocker is resolved whatever closed it", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `[${blockerRow(13, "closed", "rawphp/softfac")},${blockerRow(12, "closed", "rawphp/other")}]`,
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), []);
  }),
);

it.effect(
  "only the exact REST state `closed` resolves a blocker; any other state still blocks",
  () =>
    Effect.gen(function* () {
      // The dependency listing's state is REST's lowercase `open` or `closed`. A state the
      // factory does not know, or one in another case, is not taken as resolved: the issue
      // waits rather than starting on a guess.
      const t = setup(
        reply(
          `[${blockerRow(13, "unknown", "rawphp/softfac")},${blockerRow(12, "CLOSED", "rawphp/softfac")},${blockerRow(11, "closed", "rawphp/softfac")}]`,
        ),
      );
      assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), [
        openBlocker(13, "rawphp/softfac"),
        openBlocker(12, "rawphp/softfac"),
      ]);
    }),
);

it.effect("open blockers keep the repo they are in", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `[${blockerRow(13, "open", "rawphp/softfac")},${blockerRow(12, "closed", "rawphp/softfac")},${blockerRow(7, "open", "acme/widgets")}]`,
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), [
      openBlocker(13, "rawphp/softfac"),
      openBlocker(7, "acme/widgets"),
    ]);
  }),
);

it.effect("blockers on every page are read", () =>
  Effect.gen(function* () {
    // `gh api --paginate` may print each page as its own array.
    const t = setup(
      reply(
        `[${blockerRow(1, "closed", "rawphp/softfac")}][${blockerRow(2, "open", "rawphp/softfac")}]`,
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), [
      openBlocker(2, "rawphp/softfac"),
    ]);
  }),
);

it.effect("blockers that cannot be read are an error", () =>
  Effect.gen(function* () {
    const spawn = setup(spawnError());
    assert.strictEqual((yield* spawn.err(spawn.github.openBlockers(14)))._tag, "GitHubSpawnError");

    const failed = setup(fail(1, "Not Found"));
    assert.strictEqual((yield* failed.err(failed.github.openBlockers(14)))._tag, "GitHubFailed");

    for (const stdout of ["oops", "", '{"message":"x"}']) {
      const t = setup(reply(stdout));
      const error = yield* t.err(t.github.openBlockers(14));
      assert.strictEqual(error._tag, "GitHubParse", stdout);
    }
  }),
);

it.effect("an open blocker whose repo is unknown is an error, not a guess", () =>
  Effect.gen(function* () {
    for (const row of [
      '{"number":3,"state":"open"}',
      '{"number":3,"state":"open","repository_url":"x"}',
    ]) {
      const t = setup(reply(`[${row}]`));
      const error = yield* t.err(t.github.openBlockers(14));
      assert.strictEqual(error._tag, "GitHubParse", row);
    }
  }),
);

// ---- text blockers ----

const bodyCall = (issue: string) => ["issue", "view", issue, "--repo", REPO, "--json", "body"];
const restCall = (repo: string, issue: string) => ["api", `repos/${repo}/issues/${issue}`];
const bodyReply = (body: string) => JSON.stringify({ body });

it.effect("text blockers of a body without the section read nothing more", () =>
  Effect.gen(function* () {
    const t = setup(reply(bodyReply("## Cause\nSee #5\n")));
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), []);
    assert.deepStrictEqual(t.calls(), [bodyCall("14")]);

    const empty = setup(reply('{"body":null}'));
    assert.deepStrictEqual(yield* empty.ok(empty.github.textBlockers(14)), []);
  }),
);

it.effect("text blockers are the named issues that are not closed", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(bodyReply("## Depends on\n#13, acme/widgets#7 and #5\n\n## Fix\n#99\n")),
      reply('{"number":13,"state":"open","title":"t"}'),
      reply('{"number":7,"state":"closed"}'),
      reply('{"number":5,"state":"open"}'),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), [
      openBlocker(13, REPO),
      openBlocker(5, REPO),
    ]);
    assert.deepStrictEqual(t.calls(), [
      bodyCall("14"),
      restCall(REPO, "13"),
      restCall("acme/widgets", "7"),
      restCall(REPO, "5"),
    ]);
  }),
);

it.effect("text blockers resolved once every named issue is closed", () =>
  Effect.gen(function* () {
    const t = setup(reply(bodyReply("## Depends on\n#13\n")), reply('{"state":"closed"}'));
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), []);
  }),
);

it.effect("only the exact REST state `closed` resolves a named issue; any other still blocks", () =>
  Effect.gen(function* () {
    // The same rule as the dependency listing: a state in another case is not taken as resolved.
    const t = setup(
      reply(bodyReply("## Depends on\n#13, #12, #11\n")),
      reply('{"state":"CLOSED"}'),
      reply('{"state":"unknown"}'),
      reply('{"state":"closed"}'),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), [
      openBlocker(13, REPO),
      openBlocker(12, REPO),
    ]);
  }),
);

it.effect("a Depends on section naming more than the cap is an error before any is read", () =>
  Effect.gen(function* () {
    const refs = (count: number) =>
      Array.from({ length: count }, (_, at) => `#${at + 1}`).join(" ");

    const over = setup(reply(bodyReply(`## Depends on\n${refs(MAX_DEPENDS_ON + 1)}\n`)));
    assert.strictEqual((yield* over.err(over.github.textBlockers(14)))._tag, "GitHubParse");
    assert.deepStrictEqual(over.calls(), [bodyCall("14")]);

    const atCap = setup(
      reply(bodyReply(`## Depends on\n${refs(MAX_DEPENDS_ON)}\n`)),
      ...Array.from({ length: MAX_DEPENDS_ON }, () => reply('{"state":"closed"}')),
    );
    assert.deepStrictEqual(yield* atCap.ok(atCap.github.textBlockers(14)), []);
    assert.strictEqual(atCap.calls().length, MAX_DEPENDS_ON + 1);
  }),
);

it.effect("a named issue that cannot be read is an error, not a resolved blocker", () =>
  Effect.gen(function* () {
    const body = bodyReply("## Depends on\n#13, #5\n");
    const missing = setup(
      reply(body),
      reply('{"state":"closed"}'),
      fail(1, "gh: Not Found (HTTP 404)"),
    );
    assert.strictEqual((yield* missing.err(missing.github.textBlockers(14)))._tag, "GitHubFailed");

    const oops = setup(reply(body), reply("oops"));
    assert.strictEqual((yield* oops.err(oops.github.textBlockers(14)))._tag, "GitHubParse");

    const empty = setup(reply(body), reply("{}"));
    assert.strictEqual((yield* empty.err(empty.github.textBlockers(14)))._tag, "GitHubParse");
  }),
);

it.effect("a body that cannot be read is an error", () =>
  Effect.gen(function* () {
    const failed = setup(fail(1, "boom"));
    assert.strictEqual((yield* failed.err(failed.github.textBlockers(14)))._tag, "GitHubFailed");
    const oops = setup(reply("oops"));
    assert.strictEqual((yield* oops.err(oops.github.textBlockers(14)))._tag, "GitHubParse");
  }),
);

// ---- approval: ported from softfac's github.rs ----

/** When the instructor applied `factory:ready` in most of the approval tests. */
const LABELED = "2026-10-04T10:00:00Z";
/** After LABELED, and before LATER. */
const AFTER = "2026-10-04T10:30:00Z";
const LATER = "2026-10-04T11:00:00Z";
/** When the issue was written: the oldest entry of the edit history, by its author. */
const CREATED = "2026-10-04T08:00:00Z";

type Who = string | null;
type Edit = readonly [at: string, who: Who];
type TimelineNode = Record<string, unknown>;

const pad = (n: number) => String(n).padStart(2, "0");

const approvalCall = () => [
  "api",
  "graphql",
  "-f",
  `query=${APPROVAL_QUERY}`,
  "-f",
  "owner=rawphp",
  "-f",
  "name=softfac",
  "-F",
  "number=6",
];

const actorOf = (who: Who) => (who === null ? null : { __typename: "User", login: who });

const labelEvent = (kind: string, at: string, actor: Who, label: string): TimelineNode => ({
  __typename: kind,
  createdAt: at,
  actor: actorOf(actor),
  label: { name: label },
});
/** A RenamedTitleEvent: only who and when are asked for, never the titles. */
const renameEvent = (at: string, actor: Who): TimelineNode => ({
  __typename: "RenamedTitleEvent",
  createdAt: at,
  actor: actorOf(actor),
});
const readyOn = (at: string, actor: Who) => labelEvent("LabeledEvent", at, actor, "factory:ready");
const readyOff = (at: string, actor: Who) =>
  labelEvent("UnlabeledEvent", at, actor, "factory:ready");

/** `userContentEdits` as GitHub answers `first: 100`: newest first, with the real total. */
const editsJson = (newestFirst: ReadonlyArray<Edit>, total: number) => ({
  totalCount: total,
  nodes: newestFirst.map(([editedAt, who]) => ({ editedAt, editor: actorOf(who) })),
});

/** A history written oldest first, as the tests think of it, in GitHub's order. */
const newestFirst = (oldestFirst: ReadonlyArray<Edit>): Array<Edit> => oldestFirst.toReversed();

/** The approval answer with exactly these history nodes (newest first) and this total. */
const approvalReplyRaw = (
  events: ReadonlyArray<TimelineNode>,
  totalEvents: number,
  last: Edit | null,
  editNodes: ReadonlyArray<Edit>,
  totalEdits: number,
) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: { totalCount: totalEvents, nodes: events },
          lastEditedAt: last === null ? null : last[0],
          editor: last === null ? null : actorOf(last[1]),
          userContentEdits: editsJson(editNodes, totalEdits),
        },
      },
    },
  });

/** `events` are oldest first, as GitHub lists them. `edits` is the history oldest first. */
const approvalReply = (
  events: ReadonlyArray<TimelineNode>,
  totalEvents: number,
  last: Edit | null,
  edits: ReadonlyArray<Edit>,
) => approvalReplyRaw(events, totalEvents, last, newestFirst(edits), edits.length);

/** The events as the tests think of them, with the real total. */
const eventsReply = (
  events: ReadonlyArray<TimelineNode>,
  last: Edit | null,
  edits: ReadonlyArray<Edit>,
) => approvalReply(events, events.length, last, edits);

const creationOnly = (author: string): Array<Edit> => [[CREATED, author]];

const approvalOf = (answer: string, who: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    const found = yield* t.ok(t.github.approval(6, who));
    assert.deepStrictEqual(t.calls(), [approvalCall()]);
    return found;
  });

const approved = (labeledAt: string, labeledBy: string): Approval => ({
  kind: "approved",
  labeledAt,
  labeledBy,
});
const refused = (refusal: Refusal): Approval => ({ kind: "refused", refusal });
const editedAfter = (labeledAt: string): Refusal => ({ kind: "edited-after-label", labeledAt });
const historyCut = (labeledAt: string): Refusal => ({
  kind: "edit-history-incomplete",
  labeledAt,
});
const byNonInstructor = (by: Who, labeledAt: string): Refusal => ({
  kind: "labeled-by-non-instructor",
  by,
  labeledAt,
});
const NOT_FOUND: Refusal = { kind: "label-not-found" };
const LABEL_CUT: Refusal = { kind: "label-history-incomplete" };

it.effect("approval reads the real shapes and sends one call", () =>
  Effect.gen(function* () {
    const real =
      '{"data":{"repository":{"issue":{"timelineItems":{"totalCount":3,"nodes":[{"__typename":"UnlabeledEvent","createdAt":"2026-10-04T11:36:21Z","actor":{"__typename":"User","login":"rawphp"},"label":{"name":"factory:building"}},{"__typename":"LabeledEvent","createdAt":"2026-10-04T11:36:21Z","actor":{"__typename":"User","login":"rawphp"},"label":{"name":"factory:ready"}},{"__typename":"RenamedTitleEvent","createdAt":"2026-10-04T11:48:55Z","actor":{"__typename":"User","login":"rawphp"}}]},"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":1,"nodes":[{"editedAt":"2026-10-04T09:50:06Z","editor":{"__typename":"User","login":"outside-user"}}]}}}}}';
    assert.deepStrictEqual(
      yield* approvalOf(real, ["rawphp"]),
      approved("2026-10-04T11:36:21Z", "rawphp"),
    );
  }),
);

it.effect("an outside author's unedited report labelled by an instructor is approved", () =>
  Effect.gen(function* () {
    // The creation entry is by the author, before the label, and is ignored.
    const answer = eventsReply([readyOn(LABELED, "tom")], null, creationOnly("outsider"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("an issue with no history at all is approved when an instructor labelled it", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "tom")], null, []);
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("the instructor comparison ignores case", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "TomK")],
      [AFTER, "TOMK"],
      [
        [CREATED, "outsider"],
        [AFTER, "TOMK"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tomk"]), approved(LABELED, "TomK"));
  }),
);

it.effect("other labels in the events are ignored", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [
        labelEvent("LabeledEvent", "2026-10-04T09:00:00Z", "eve", "bug"),
        readyOn(LABELED, "tom"),
        labelEvent("UnlabeledEvent", AFTER, "eve", "bug"),
        labelEvent("LabeledEvent", AFTER, "eve", "factory:readyish"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect(
  "a label applied, removed and applied again by an instructor counts the later event",
  () =>
    Effect.gen(function* () {
      // A non-instructor applied it first and an instructor reviewed and re-applied it.
      const answer = eventsReply(
        [
          readyOn("2026-10-04T09:00:00Z", "eve"),
          readyOff("2026-10-04T09:30:00Z", "tom"),
          readyOn(LABELED, "tom"),
        ],
        null,
        creationOnly("eve"),
      );
      assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
    }),
);

it.effect("a label applied by an instructor then reapplied by a non-instructor is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [
        readyOn("2026-10-04T09:00:00Z", "tom"),
        readyOff("2026-10-04T09:30:00Z", "tom"),
        readyOn(LABELED, "eve"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("eve", LABELED)),
    );
  }),
);

it.effect("a label applied by a non-instructor is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "eve")], null, creationOnly("eve"));
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("eve", LABELED)),
    );
  }),
);

it.effect("a label applied by a deleted account is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, null)], null, creationOnly("tom"));
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor(null, LABELED)),
    );
  }),
);

it.effect("a label that was removed and not applied again is not found", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn("2026-10-04T09:00:00Z", "tom"), readyOff(LABELED, "tom")],
      null,
      creationOnly("tom"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(NOT_FOUND));
  }),
);

it.effect("no label events at all is not found", () =>
  Effect.gen(function* () {
    const answer = eventsReply([], null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(NOT_FOUND));
  }),
);

/** `n` events about another label, oldest first. */
const noise = (n: number): Array<TimelineNode> =>
  Array.from({ length: n }, (_, i) =>
    labelEvent(
      i % 2 === 0 ? "LabeledEvent" : "UnlabeledEvent",
      "2026-10-04T09:00:00Z",
      "tom",
      "bug",
    ),
  );

it.effect("a hundred events of a longer history without the label is incomplete", () =>
  Effect.gen(function* () {
    const answer = approvalReply(noise(100), 150, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(LABEL_CUT));
  }),
);

it.effect("a label found among the newest hundred is enough whatever the total", () =>
  Effect.gen(function* () {
    const events = [...noise(99), readyOn(LABELED, "tom")];
    const answer = approvalReply(events, 400, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("a removal among the newest hundred is not a missing history", () =>
  Effect.gen(function* () {
    // The label was taken off in view: the history is not why it is missing.
    const events = [readyOn("2026-10-04T08:30:00Z", "tom"), ...noise(98), readyOff(LABELED, "tom")];
    const answer = approvalReply(events, 100, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(NOT_FOUND));
  }),
);

it.effect("a complete hundred or a short page without the label is only not found", () =>
  Effect.gen(function* () {
    // Exactly 100 in all: nothing is hidden.
    const whole = approvalReply(noise(100), 100, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(whole, ["tom"]), refused(NOT_FOUND));
    // A page short of 100 is not the cut-off that rule is about.
    const short = approvalReply(noise(99), 120, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(short, ["tom"]), refused(NOT_FOUND));
  }),
);

it.effect("an instructor edit after the label is approved", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, "amy"],
      [
        [CREATED, "eve"],
        [AFTER, "amy"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom", "amy"]), approved(LABELED, "tom"));
  }),
);

it.effect("a non-instructor edit after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, "eve"],
      [
        [CREATED, "eve"],
        [AFTER, "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a non-instructor edit followed by an instructor edit is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [LATER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "eve"],
        [LATER, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("an edit by a deleted account after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, null],
      [
        [CREATED, "eve"],
        [AFTER, null],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("edits before the label are ignored whoever made them", () =>
  Effect.gen(function* () {
    // The instructor approved the text as it stood when they applied the label.
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      ["2026-10-04T09:30:00Z", "eve"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:00:00Z", null],
        ["2026-10-04T09:30:00Z", "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("an edit in the same second as the label counts as after it", () =>
  Effect.gen(function* () {
    const stranger = eventsReply(
      [readyOn(LABELED, "tom")],
      [LABELED, "eve"],
      [
        [CREATED, "eve"],
        [LABELED, "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(stranger, ["tom"]), refused(editedAfter(LABELED)));
    // An instructor's edit in that second is fine, and one second earlier is before it.
    const instructor = eventsReply(
      [readyOn(LABELED, "tom")],
      [LABELED, "tom"],
      [
        [CREATED, "eve"],
        [LABELED, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(instructor, ["tom"]), approved(LABELED, "tom"));
    const before = eventsReply(
      [readyOn(LABELED, "tom")],
      ["2026-10-04T09:59:59Z", "eve"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:59:59Z", "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(before, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("only the label that is in force sets the cut off for edits", () =>
  Effect.gen(function* () {
    // An edit between an old, removed label and the label now in force is before it.
    const answer = eventsReply(
      [
        readyOn("2026-10-04T09:00:00Z", "tom"),
        readyOff("2026-10-04T09:10:00Z", "tom"),
        readyOn(LABELED, "tom"),
      ],
      ["2026-10-04T09:30:00Z", "eve"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:30:00Z", "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

/** `n` seconds, one apart, from 10:01:00. */
const secondsAfterLabel = (n: number): Array<string> =>
  Array.from(
    { length: n },
    (_, i) => `2026-10-04T10:${pad(1 + Math.floor(i / 60))}:${pad(i % 60)}Z`,
  );

it.effect("a full page of edits is an incomplete history", () =>
  Effect.gen(function* () {
    const times = secondsAfterLabel(100);
    const history = (n: number): Array<Edit> => times.slice(0, n).map((t) => [t, "tom"]);
    const last = (n: number): Edit => [times[n - 1]!, "tom"];
    const events = () => [readyOn(LABELED, "tom")];
    assert.deepStrictEqual(
      yield* approvalOf(eventsReply(events(), last(99), history(99)), ["tom"]),
      approved(LABELED, "tom"),
    );
    assert.deepStrictEqual(
      yield* approvalOf(eventsReply(events(), last(100), history(100)), ["tom"]),
      refused(historyCut(LABELED)),
    );
  }),
);

it.effect(
  "an edit total above the page is an incomplete history when the label may be hidden",
  () =>
    Effect.gen(function* () {
      // Both shown entries are after the label, so older ones could be too.
      const nodes: Array<Edit> = [
        [LATER, "tom"],
        [AFTER, "tom"],
      ];
      const last: Edit = [LATER, "tom"];
      const run = (total: number) =>
        approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, total), ["tom"]);
      assert.deepStrictEqual(yield* run(2), approved(LABELED, "tom"));
      assert.deepStrictEqual(yield* run(5), refused(historyCut(LABELED)));
    }),
);

it.effect("the newest edit entry must be the last edit", () =>
  Effect.gen(function* () {
    const create: Edit = [CREATED, "tom"];
    const last: Edit = [AFTER, "tom"];
    const run = (nodes: ReadonlyArray<Edit>) =>
      approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, nodes.length), [
        "tom",
        "amy",
      ]);
    assert.deepStrictEqual(yield* run([[AFTER, "tom"], create]), approved(LABELED, "tom"));
    // Another time, another editor (both instructors), or no entry for it.
    const wrong: ReadonlyArray<ReadonlyArray<Edit>> = [
      [["2026-10-04T10:20:00Z", "tom"], create],
      [[AFTER, "amy"], create],
      [create],
      [],
    ];
    for (const nodes of wrong) {
      assert.deepStrictEqual(yield* run(nodes), refused(historyCut(LABELED)));
    }
  }),
);

it.effect("a visible stranger edit is named even when the history is also cut off", () =>
  Effect.gen(function* () {
    const nodes: Array<Edit> = [
      [AFTER, "eve"],
      [CREATED, "tom"],
    ];
    const answer = approvalReplyRaw([readyOn(LABELED, "tom")], 1, [AFTER, "eve"], nodes, 9);
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("the label is judged before the edits", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "eve")],
      [AFTER, "eve"],
      [
        [CREATED, "eve"],
        [AFTER, "eve"],
      ],
    );
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("eve", LABELED)),
    );
  }),
);

it.effect("approval with no instructors approves nothing", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "tom")], null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, []), refused(byNonInstructor("tom", LABELED)));
  }),
);

/** The error `approval` gives for this answer, or null when it reads it. */
const approvalError = (answer: string) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    return yield* t.ok(
      t.github
        .approval(6, ["tom"])
        .pipe(Effect.match({ onFailure: (e) => e, onSuccess: () => null })),
    );
  });

/** Whether `answer` is a parse error that names the approval call. */
const isApprovalParseError = (answer: string) =>
  approvalError(answer).pipe(
    Effect.map(
      (error) =>
        error !== null &&
        error._tag === "GitHubParse" &&
        JSON.stringify(error.args) === JSON.stringify(approvalCall()),
    ),
  );

it.effect("approval answers that cannot be read are parse errors", () =>
  Effect.gen(function* () {
    const good = (events: unknown, edits: unknown) =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              timelineItems: { totalCount: 1, nodes: events },
              lastEditedAt: null,
              editor: null,
              userContentEdits: edits,
            },
          },
        },
      });
    const edits = editsJson([[CREATED, "tom"]], 1);
    // The control: this one is fine.
    assert.isFalse(yield* isApprovalParseError(good([readyOn(LABELED, "tom")], edits)));

    for (const bad of [
      "not json",
      "",
      "{}",
      '{"data":{"repository":null}}',
      '{"errors":[{"message":"x"}]}',
      // No label events, no edit history, no total counts.
      '{"data":{"repository":{"issue":{"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":0,"nodes":[]}}}}}',
      '{"data":{"repository":{"issue":{"timelineItems":{"totalCount":0,"nodes":[]},"lastEditedAt":null,"editor":null}}}}',
      '{"data":{"repository":{"issue":{"timelineItems":{"nodes":[]},"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":0,"nodes":[]}}}}}',
    ]) {
      assert.isTrue(yield* isApprovalParseError(bad), bad);
    }
    // A node missing its time, its label, or its type, or of a type we did not ask for.
    for (const broken of [
      { __typename: "LabeledEvent", actor: { login: "tom" }, label: { name: "factory:ready" } },
      { __typename: "LabeledEvent", createdAt: LABELED, actor: { login: "tom" } },
      { createdAt: LABELED, actor: { login: "tom" }, label: { name: "factory:ready" } },
      { __typename: "ClosedEvent", createdAt: LABELED },
    ]) {
      assert.isTrue(yield* isApprovalParseError(good([broken], edits)), JSON.stringify(broken));
    }
  }),
);

it.effect("a malformed timestamp is a parse error", () =>
  Effect.gen(function* () {
    for (const at of ["2026-10-04 10:00:00Z", "2026-10-04T10:00:00", "", "yesterday"]) {
      // In the label event.
      const inLabel = eventsReply([readyOn(at, "tom")], null, creationOnly("tom"));
      assert.isTrue(yield* isApprovalParseError(inLabel), `label at ${at}`);
      // In the edit history.
      const inEdit = eventsReply(
        [readyOn(LABELED, "tom")],
        [AFTER, "tom"],
        [
          [CREATED, "tom"],
          [at, "tom"],
        ],
      );
      assert.isTrue(yield* isApprovalParseError(inEdit), `edit at ${at}`);
      // In lastEditedAt.
      const inLast = eventsReply(
        [readyOn(LABELED, "tom")],
        [at, "tom"],
        [
          [CREATED, "tom"],
          [at, "tom"],
        ],
      );
      assert.isTrue(yield* isApprovalParseError(inLast), `last edit at ${at}`);
      // In a rename.
      const inRename = eventsReply(
        [readyOn(LABELED, "tom"), renameEvent(at, "tom")],
        null,
        creationOnly("tom"),
      );
      assert.isTrue(yield* isApprovalParseError(inRename), `rename at ${at}`);
    }
  }),
);

it.effect("approval failures from gh are errors with the call", () =>
  Effect.gen(function* () {
    const failed = setup(fail(1, "HTTP 502"));
    const error = yield* failed.err(failed.github.approval(6, ["tom"]));
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.deepStrictEqual(error._tag === "GitHubFailed" && error.args, approvalCall());
    assert.strictEqual(error._tag === "GitHubFailed" && error.status, 1);

    const spawn = setup(spawnError());
    assert.strictEqual(
      (yield* spawn.err(spawn.github.approval(6, ["tom"])))._tag,
      "GitHubSpawnError",
    );
  }),
);

// ---- approval: titles, same second, long histories, non-human actors ----

/** `n` instructor renames after the label, oldest first, one second apart. */
const renamesAfterLabel = (n: number): Array<TimelineNode> =>
  secondsAfterLabel(n).map((at) => renameEvent(at, "tom"));

it.effect("a title renamed by a non-instructor after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "eve")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a title renamed by an instructor after the label is approved", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "AMY")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom", "amy"]), approved(LABELED, "tom"));
  }),
);

it.effect("a rename by a deleted account after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, null)],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a stranger rename followed by an instructor rename is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "eve"), renameEvent(LATER, "tom")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a stranger rename is refused even when every body edit is an instructor's", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(LATER, "eve")],
      [AFTER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("renames before the label in force are ignored", () =>
  Effect.gen(function* () {
    // Before the label, and between a removed label and the one in force.
    const answer = eventsReply(
      [
        renameEvent("2026-10-04T08:30:00Z", "eve"),
        readyOn("2026-10-04T09:00:00Z", "tom"),
        readyOff("2026-10-04T09:10:00Z", "tom"),
        renameEvent("2026-10-04T09:30:00Z", null),
        readyOn(LABELED, "tom"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("a rename in the same second as the label counts as after it", () =>
  Effect.gen(function* () {
    const stranger = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(LABELED, "eve")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(stranger, ["tom"]), refused(editedAfter(LABELED)));
    const instructor = eventsReply(
      [
        renameEvent("2026-10-04T09:59:59Z", "eve"),
        readyOn(LABELED, "tom"),
        renameEvent(LABELED, "tom"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(instructor, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("labels and renames share the page and the label in force is enough", () =>
  Effect.gen(function* () {
    // The label is the oldest event shown, so every later event, the renames included, is on
    // the page: events come oldest first and the page is the newest 100. Nothing before the
    // label matters, whatever the total.
    const events = [readyOn(LABELED, "tom"), ...renamesAfterLabel(99)];
    const answer = approvalReply(events, 400, null, creationOnly("eve"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));

    // A stranger's rename on that page is seen.
    const withStranger = [...events];
    withStranger[50] = renameEvent("2026-10-04T10:20:00Z", "eve");
    const seen = approvalReply(withStranger, 400, null, creationOnly("eve"));
    assert.deepStrictEqual(yield* approvalOf(seen, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect(
  "a page of renames without the label is a missing label history, not a stranger edit",
  () =>
    Effect.gen(function* () {
      // The label is older than all 100 shown events. Nothing shown can be told to be after it.
      const events = Array.from({ length: 100 }, () => renameEvent(AFTER, "eve"));
      const answer = approvalReply(events, 150, null, creationOnly("eve"));
      assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(LABEL_CUT));
    }),
);

/** `n` seconds, one apart, from `hour`:00:00. */
const editTimes = (hour: number, n: number): Array<string> =>
  Array.from(
    { length: n },
    (_, i) => `2026-10-04T${pad(hour)}:${pad(Math.floor(i / 60))}:${pad(i % 60)}Z`,
  );

it.effect(
  "a hundred edits with the oldest shown before the label are judged by the visible ones",
  () =>
    Effect.gen(function* () {
      // 99 entries before the label (09:xx) and the newest, an instructor's, after it.
      const history: Array<Edit> = [
        ...editTimes(9, 99).map((t): Edit => [t, "tom"]),
        [AFTER, "tom"],
      ];
      const events = () => [readyOn(LABELED, "tom")];
      const answer = eventsReply(events(), [AFTER, "tom"], history);
      assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));

      // The same page with the newest edit by a stranger.
      const withStranger: Array<Edit> = [...history.slice(0, -1), [AFTER, "eve"]];
      const refusedAnswer = eventsReply(events(), [AFTER, "eve"], withStranger);
      assert.deepStrictEqual(
        yield* approvalOf(refusedAnswer, ["tom"]),
        refused(editedAfter(LABELED)),
      );
    }),
);

it.effect("a hundred edits all after the label cannot be judged", () =>
  Effect.gen(function* () {
    const times = secondsAfterLabel(100);
    const history = times.map((t): Edit => [t, "tom"]);
    const answer = eventsReply([readyOn(LABELED, "tom")], [times[99]!, "tom"], history);
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(historyCut(LABELED)));
  }),
);

it.effect("a total above the page is judged when the oldest shown entry is before the label", () =>
  Effect.gen(function* () {
    const last: Edit = [LATER, "tom"];
    const run = (nodes: ReadonlyArray<Edit>) =>
      approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, 150), ["tom"]);
    assert.deepStrictEqual(
      yield* run([
        [LATER, "tom"],
        [AFTER, "tom"],
        ["2026-10-04T09:30:00Z", "tom"],
      ]),
      approved(LABELED, "tom"),
    );
    // The oldest shown entry must be strictly before the label.
    assert.deepStrictEqual(
      yield* run([
        [LATER, "tom"],
        [LABELED, "tom"],
      ]),
      refused(historyCut(LABELED)),
    );
    assert.deepStrictEqual(
      yield* run([
        [LATER, "tom"],
        [AFTER, "tom"],
      ]),
      refused(historyCut(LABELED)),
    );
  }),
);

it.effect("a cut page still needs its newest entry to be the last edit", () =>
  Effect.gen(function* () {
    const nodes: Array<Edit> = [
      [LATER, "tom"],
      ...editTimes(9, 99)
        .toReversed()
        .map((t): Edit => [t, "tom"]),
    ];
    assert.strictEqual(nodes.length, 100);
    const run = (last: Edit) =>
      approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, 100), ["tom"]);
    assert.deepStrictEqual(yield* run([LATER, "tom"]), approved(LABELED, "tom"));
    // GitHub says the last edit was another one.
    assert.deepStrictEqual(yield* run([AFTER, "tom"]), refused(historyCut(LABELED)));
    assert.deepStrictEqual(yield* run([LATER, "amy"]), refused(historyCut(LABELED)));
  }),
);

it.effect("a label applied by an actor that is not a user is refused whatever its login", () =>
  Effect.gen(function* () {
    for (const typename of ["Bot", "Organization", "Mannequin", "EnterpriseUserAccount", ""]) {
      const event = { ...readyOn(LABELED, "tom"), actor: { __typename: typename, login: "tom" } };
      const answer = eventsReply([event], null, creationOnly("eve"));
      assert.deepStrictEqual(
        yield* approvalOf(answer, ["tom"]),
        refused(byNonInstructor("tom", LABELED)),
        typename,
      );
    }
  }),
);

it.effect("an actor without a typename is not an instructor", () =>
  Effect.gen(function* () {
    const event = { ...readyOn(LABELED, "tom"), actor: { login: "tom" } };
    const answer = eventsReply([event], null, creationOnly("eve"));
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("tom", LABELED)),
    );
  }),
);

/** `answer` with the type of the newest history entry's editor replaced. */
const withEditorTypename = (answer: string, typename: string): string => {
  const json = JSON.parse(answer) as {
    data: {
      repository: {
        issue: { userContentEdits: { nodes: Array<{ editor: { __typename: string } }> } };
      };
    };
  };
  json.data.repository.issue.userContentEdits.nodes[0]!.editor.__typename = typename;
  return JSON.stringify(json);
};

it.effect("a body edit or rename by something that is not a user after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
    for (const typename of ["Bot", "Mannequin", ""]) {
      assert.deepStrictEqual(
        yield* approvalOf(withEditorTypename(answer, typename), ["tom"]),
        refused(editedAfter(LABELED)),
        `edit by ${typename}`,
      );
    }

    const rename = { ...renameEvent(AFTER, "tom"), actor: { __typename: "Bot", login: "tom" } };
    const renamed = eventsReply([readyOn(LABELED, "tom"), rename], null, creationOnly("eve"));
    assert.deepStrictEqual(yield* approvalOf(renamed, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a creation entry by something that is not a user before the label is ignored", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "tom")], null, creationOnly("dependabot"));
    assert.deepStrictEqual(
      yield* approvalOf(withEditorTypename(answer, "Bot"), ["tom"]),
      approved(LABELED, "tom"),
    );
  }),
);

it.effect("approval for a repo that is not owner/name makes no call", () =>
  Effect.gen(function* () {
    const t = setup();
    const error = yield* t.err(
      makeGitHub({ repo: "softfac", ghConfigDir: GH_CONFIG_DIR }).approval(6, ["tom"]),
    );
    assert.strictEqual(error._tag, "GitHubParse");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

// ---- text check ----

const textCheckOf = (answer: string, since: string, who: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    const found: TextCheck = yield* t.ok(t.github.textCheck(6, since, who));
    assert.deepStrictEqual(t.calls(), [approvalCall()]);
    return found;
  });

it.effect("text check tells unchanged from changed from unjudged", () =>
  Effect.gen(function* () {
    // Unchanged: instructors only.
    const instructors = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "tom")],
      [AFTER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "tom"],
      ],
    );
    assert.strictEqual(yield* textCheckOf(instructors, LABELED, ["tom"]), "unchanged");
    // Changed: a stranger's rename, a deleted account's edit.
    const renamed = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "eve")],
      null,
      creationOnly("eve"),
    );
    assert.strictEqual(yield* textCheckOf(renamed, LABELED, ["tom"]), "changed");
    const edited = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, null],
      [
        [CREATED, "eve"],
        [AFTER, null],
      ],
    );
    assert.strictEqual(yield* textCheckOf(edited, LABELED, ["tom"]), "changed");
  }),
);

it.effect("text check says unjudged when the histories cannot be read whole", () =>
  Effect.gen(function* () {
    // A full page of body edits after the label, all by instructors, with more behind it.
    const times = secondsAfterLabel(100);
    const oldestFirst = times.map((t): Edit => [t, "tom"]);
    const last: Edit = [times[99]!, "tom"];
    const full = eventsReply([readyOn(LABELED, "tom")], last, oldestFirst);
    assert.strictEqual(yield* textCheckOf(full, LABELED, ["tom"]), "unjudged");
    // A stranger shown on that page is still a change: it wins.
    const withStranger = [...oldestFirst];
    withStranger[50] = [times[50]!, "eve"];
    const stranger = eventsReply([readyOn(LABELED, "tom")], last, withStranger);
    assert.strictEqual(yield* textCheckOf(stranger, LABELED, ["tom"]), "changed");
  }),
);

it.effect("text check ignores who applied labels but not bots", () =>
  Effect.gen(function* () {
    // Labels are not text: a stranger's label event is not a change.
    const labelled = eventsReply(
      [readyOn(LABELED, "tom"), labelEvent("LabeledEvent", AFTER, "eve", "bug")],
      null,
      creationOnly("eve"),
    );
    assert.strictEqual(yield* textCheckOf(labelled, LABELED, ["tom"]), "unchanged");
    // A bot with an instructor's login is not an instructor.
    const rename = { ...renameEvent(AFTER, "tom"), actor: { __typename: "Bot", login: "tom" } };
    const bot = eventsReply([readyOn(LABELED, "tom"), rename], null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(bot, LABELED, ["tom"]), "changed");
  }),
);

it.effect("text check cannot judge histories that may hide something", () =>
  Effect.gen(function* () {
    // A full page of body edits all at or after the moment.
    const times = secondsAfterLabel(100);
    const history = times.map((t): Edit => [t, "tom"]);
    const edits = eventsReply([readyOn(LABELED, "tom")], [times[99]!, "tom"], history);
    assert.strictEqual(yield* textCheckOf(edits, LABELED, ["tom"]), "unjudged");

    // A full timeline page whose oldest event is at or after the moment may hide renames.
    const events = Array.from({ length: 100 }, () => renameEvent(AFTER, "tom"));
    const full = approvalReply(events, 150, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(full, LABELED, ["tom"]), "unjudged");
    // The same page with its oldest event before the moment shows everything after it.
    const reaching = [renameEvent("2026-10-04T09:00:00Z", "eve"), ...events.slice(1)];
    const reachingAnswer = approvalReply(reaching, 150, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(reachingAnswer, LABELED, ["tom"]), "unchanged");

    // The newest body entry must be the last edit.
    const stale = approvalReplyRaw(
      [readyOn(LABELED, "tom")],
      1,
      [AFTER, "tom"],
      [[CREATED, "eve"]],
      1,
    );
    assert.strictEqual(yield* textCheckOf(stale, LABELED, ["tom"]), "unjudged");
  }),
);

it.effect("a cut off timeline page whose oldest event is exactly at since cannot be judged", () =>
  Effect.gen(function* () {
    // Events before `since` could still be hidden at the same second, so the page must reach
    // strictly before it.
    const page = (oldest: string) =>
      approvalReply(
        [
          renameEvent(oldest, "tom"),
          ...Array.from({ length: 99 }, () => renameEvent(AFTER, "tom")),
        ],
        150,
        null,
        creationOnly("eve"),
      );
    assert.strictEqual(yield* textCheckOf(page(LABELED), LABELED, ["tom"]), "unjudged");
    assert.strictEqual(yield* textCheckOf(page(AFTER), LABELED, ["tom"]), "unjudged");
    assert.strictEqual(
      yield* textCheckOf(page("2026-10-04T09:59:59Z"), LABELED, ["tom"]),
      "unchanged",
    );
  }),
);

it.effect("each half of the timeline cut off rule alone stops the judgement", () =>
  Effect.gen(function* () {
    const renames = (n: number) => Array.from({ length: n }, () => renameEvent(AFTER, "tom"));
    // A full page of 100 with nothing more: still a page that may have been cut.
    const full = approvalReply(renames(100), 100, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(full, LABELED, ["tom"]), "unjudged");
    // Fewer than 100 shown with a larger total: something is hidden.
    const short = approvalReply(renames(99), 120, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(short, LABELED, ["tom"]), "unjudged");
    // The control: 99 shown of a total of 99 is the whole timeline.
    const whole = approvalReply(renames(99), 99, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(whole, LABELED, ["tom"]), "unchanged");
  }),
);

it.effect("text check is changed for a stranger edit or rename at or after the moment", () =>
  Effect.gen(function* () {
    const edited = (at: string, who: Who) =>
      eventsReply(
        [readyOn(LABELED, "tom")],
        [at, who],
        [
          [CREATED, "eve"],
          [at, who],
        ],
      );
    const renamed = (at: string, who: Who) =>
      eventsReply([readyOn(LABELED, "tom"), renameEvent(at, who)], null, creationOnly("eve"));
    for (const at of [LABELED, AFTER]) {
      for (const who of ["eve", null]) {
        assert.strictEqual(yield* textCheckOf(edited(at, who), LABELED, ["tom"]), "changed");
        assert.strictEqual(yield* textCheckOf(renamed(at, who), LABELED, ["tom"]), "changed");
      }
    }
    // One second before the moment is before it.
    assert.strictEqual(
      yield* textCheckOf(edited("2026-10-04T09:59:59Z", "eve"), LABELED, ["tom"]),
      "unchanged",
    );
    assert.strictEqual(
      yield* textCheckOf(renamed("2026-10-04T09:59:59Z", "eve"), LABELED, ["tom"]),
      "unchanged",
    );
  }),
);

it.effect("text check with a timestamp that is not GitHub's form makes no call", () =>
  Effect.gen(function* () {
    for (const since of ["", "2026-10-04 10:00:00Z", "2026-10-04T10:00:00", "now"]) {
      const t = setup();
      const error = yield* t.err(t.github.textCheck(6, since, ["tom"]));
      assert.strictEqual(error._tag, "GitHubParse", since);
      assert.deepStrictEqual(error._tag === "GitHubParse" && error.args, ["api", "graphql"]);
      assert.deepStrictEqual(t.calls(), [], since);
    }
  }),
);

it.effect("text check errors are typed", () =>
  Effect.gen(function* () {
    const bad = setup(reply("not json"));
    const parse = yield* bad.err(bad.github.textCheck(6, LABELED, ["tom"]));
    assert.strictEqual(parse._tag, "GitHubParse");
    assert.deepStrictEqual(parse._tag === "GitHubParse" && parse.args, approvalCall());

    const failed = setup(fail(1, "HTTP 502"));
    const error = yield* failed.err(failed.github.textCheck(6, LABELED, ["tom"]));
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.strictEqual(error._tag === "GitHubFailed" && error.status, 1);

    const answer = eventsReply([readyOn(LABELED, "tom")], ["later", "tom"], creationOnly("tom"));
    const malformed = setup(reply(answer));
    assert.strictEqual(
      (yield* malformed.err(malformed.github.textCheck(6, LABELED, ["tom"])))._tag,
      "GitHubParse",
    );
  }),
);

// ---- text edited since ----

const editedSinceOf = (answer: string, since: string) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    const found = yield* t.ok(t.github.textEditedSince(6, since));
    assert.deepStrictEqual(t.calls(), [approvalCall()]);
    return found;
  });

it.effect("text edited since is false when nothing touched the text at or after the moment", () =>
  Effect.gen(function* () {
    // An edit and a rename before the moment, by anyone, and a label event after it.
    const answer = eventsReply(
      [
        renameEvent("2026-10-04T09:00:00Z", "eve"),
        readyOn(LABELED, "tom"),
        labelEvent("LabeledEvent", AFTER, "eve", "bug"),
      ],
      ["2026-10-04T09:59:59Z", "tom"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:59:59Z", "tom"],
      ],
    );
    assert.isFalse(yield* editedSinceOf(answer, LABELED));
  }),
);

it.effect(
  "text edited since is true for any edit or rename at or after the moment, even an instructor's",
  () =>
    Effect.gen(function* () {
      for (const at of [LABELED, AFTER]) {
        const edited = eventsReply(
          [readyOn(LABELED, "tom")],
          [at, "tom"],
          [
            [CREATED, "eve"],
            [at, "tom"],
          ],
        );
        assert.isTrue(yield* editedSinceOf(edited, LABELED), `edit at ${at}`);
        const renamed = eventsReply(
          [readyOn(LABELED, "tom"), renameEvent(at, "tom")],
          null,
          creationOnly("eve"),
        );
        assert.isTrue(yield* editedSinceOf(renamed, LABELED), `rename at ${at}`);
      }
    }),
);

it.effect("text edited since is true when the timeline may hide a rename", () =>
  Effect.gen(function* () {
    // A full page of newer label events with more behind it: a rename at the moment could be
    // among the hidden ones.
    const events = Array.from({ length: 100 }, (_, i) =>
      labelEvent(
        "LabeledEvent",
        `2026-10-04T11:${pad(Math.floor(i / 60))}:${pad(i % 60)}Z`,
        "eve",
        "bug",
      ),
    );
    const answer = approvalReply(events, 150, null, creationOnly("eve"));
    assert.isTrue(yield* editedSinceOf(answer, LABELED));
  }),
);

it.effect("text edited since refuses a moment that is not a GitHub timestamp", () =>
  Effect.gen(function* () {
    const t = setup();
    const error = yield* t.err(t.github.textEditedSince(6, "yesterday"));
    assert.strictEqual(error._tag, "GitHubParse");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

// ---- the GitHub tracker delegates (from softfac's runner tests) ----

it.effect(
  "approval sends one graphql call for the issue and uses the instructors it is given",
  () =>
    Effect.gen(function* () {
      const answer = JSON.stringify({
        data: {
          repository: {
            issue: {
              timelineItems: {
                totalCount: 1,
                nodes: [readyOn("2026-10-04T11:36:21Z", "rawphp")],
              },
              lastEditedAt: null,
              editor: null,
              userContentEdits: editsJson([["2026-10-04T09:50:06Z", "outsider"]], 1),
            },
          },
        },
      });
      const t = setup(reply(answer));
      const found = yield* t.ok(t.github.approval(10, ["rawphp"]));
      assert.deepStrictEqual(found, approved("2026-10-04T11:36:21Z", "rawphp"));
      const calls = t.calls();
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.slice(0, 2), ["api", "graphql"]);
      assert.include(calls[0]!, "number=10");
    }),
);

/** A recorded answer of the approval query: the label at 10:00 and an outsider's rename at 10:30. */
const RENAMED_BY_OUTSIDER =
  '{"data":{"repository":{"issue":{"timelineItems":{"totalCount":2,"nodes":[{"__typename":"LabeledEvent","createdAt":"2026-10-04T10:00:00Z","actor":{"__typename":"User","login":"rawphp"},"label":{"name":"factory:ready"}},{"__typename":"RenamedTitleEvent","createdAt":"2026-10-04T10:30:00Z","actor":{"__typename":"User","login":"outsider"}}]},"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":1,"nodes":[{"editedAt":"2026-10-04T09:50:06Z","editor":{"__typename":"User","login":"outsider"}}]}}}}}';

it.effect("text check sends one graphql call per check and uses the instructors it is given", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(RENAMED_BY_OUTSIDER),
      reply(RENAMED_BY_OUTSIDER),
      reply(RENAMED_BY_OUTSIDER),
    );
    // The rename is at or after the first moment and before the second.
    assert.strictEqual(
      yield* t.ok(t.github.textCheck(10, "2026-10-04T10:00:00Z", ["rawphp"])),
      "changed",
    );
    assert.strictEqual(
      yield* t.ok(t.github.textCheck(10, "2026-10-04T10:30:01Z", ["rawphp"])),
      "unchanged",
    );
    // The list passed is the one used: with the outsider as an instructor it is unchanged.
    assert.strictEqual(
      yield* t.ok(t.github.textCheck(10, "2026-10-04T10:00:00Z", ["outsider"])),
      "unchanged",
    );
    const calls = t.calls();
    assert.strictEqual(calls.length, 3);
    for (const call of calls) {
      assert.strictEqual(call.length, 10);
      assert.deepStrictEqual(call.slice(0, 3), ["api", "graphql", "-f"]);
      assert.isTrue(call[3]!.startsWith("query=query($owner: String!, $name: String!"));
      assert.include(call[3]!, "RENAMED_TITLE_EVENT");
      assert.deepStrictEqual(call.slice(4), [
        "-f",
        "owner=rawphp",
        "-f",
        "name=softfac",
        "-F",
        "number=10",
      ]);
    }
  }),
);

// ---- the claim, its repair reads, and the login (issue #15) ----

const BEFORE = "2026-10-08T02:00:00Z";

const historyCallFor = (issue: number) => [
  "api",
  "graphql",
  "-f",
  `query=${APPROVAL_QUERY}`,
  "-f",
  "owner=rawphp",
  "-f",
  "name=softfac",
  "-F",
  `number=${issue}`,
];

const claimedListCall = (label: string) => [
  "issue",
  "list",
  "--repo",
  REPO,
  "--state",
  "open",
  "--label",
  label,
  "--limit",
  "200",
  "--json",
  "number,assignees,updatedAt",
];

/** A history whose newest event of `label` was added by `by`. */
const labelledBy = (by: string, label: string) =>
  eventsReply([labelEvent("LabeledEvent", LABELED, by, label)], null, []);

const scan = (
  t: ReturnType<typeof setup>,
  known: ReadonlySet<number> = new Set<number>(),
  memo: ClaimMemo = new ClaimMemo(),
) => t.github.unassignedClaims(BEFORE, "rawphp", known, memo);

it.effect("login asks the api who is logged in with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"login":"Rawphp","id":1,"type":"User"}'));
    assert.strictEqual(yield* t.ok(t.github.login()), "Rawphp");
    assert.deepStrictEqual(t.calls(), [["api", "user"]]);
  }),
);

it.effect("login refuses an answer without a login", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"login":"","id":1}'));
    const error = yield* t.err(t.github.login());
    assert.strictEqual(error._tag, "GitHubParse");
    const t2 = setup(reply('{"id":1}'));
    assert.strictEqual((yield* t2.err(t2.github.login()))._tag, "GitHubParse");
  }),
);

it.effect("claim views the assignees, then assigns and swaps the labels in one edit", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"assignees":[]}'), reply(""));
    const outcome = yield* t.ok(t.github.claim(6, "rawphp", "ready", "triage"));
    assert.deepStrictEqual(outcome, { kind: "claimed" });
    assert.deepStrictEqual(t.calls(), [
      ["issue", "view", "6", "--repo", REPO, "--json", "assignees"],
      editCall(
        "--add-assignee",
        "rawphp",
        "--remove-label",
        "factory:ready",
        "--add-label",
        "factory:triage",
      ),
    ]);
  }),
);

it.effect("claim leaves an issue that already has any assignee alone", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"assignees":[{"login":"a"},{"login":"b"}]}'));
    const outcome = yield* t.ok(t.github.claim(6, "rawphp", "ready", "triage"));
    assert.deepStrictEqual(outcome, { kind: "skipped-assigned", assignees: ["a", "b"] });
    assert.strictEqual(t.calls().length, 1);
  }),
);

it.effect("claim passes on a failing edit", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"assignees":[]}'), fail(1, "boom"));
    const error = yield* t.err(t.github.claim(6, "rawphp", "ready", "triage"));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect("unassignedClaims lists triage then building with the exact calls", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), reply("[]"));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, []);
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      claimedListCall("factory:building"),
    ]);
  }),
);

it.effect("unassignedClaims keeps only unassigned issues that are old enough, by number", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":9,"assignees":[],"updatedAt":"2026-10-08T01:00:00Z"},
      {"number":6,"assignees":[],"updatedAt":"2026-10-08T01:59:59Z"},
      {"number":7,"assignees":[{"login":"a"}],"updatedAt":"2026-10-01T00:00:00Z"},
      {"number":8,"assignees":[],"updatedAt":"2026-10-08T03:00:00Z"},
      {"number":10,"assignees":[],"updatedAt":"2026-10-08T02:00:00Z"}
    ]`;
    const building = `[
      {"number":4,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":3,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(
      reply(triage),
      reply(labelledBy("rawphp", "factory:triage")),
      reply(labelledBy("rawphp", "factory:triage")),
      reply(building),
      reply(labelledBy("rawphp", "factory:building")),
      reply(labelledBy("rawphp", "factory:building")),
    );
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, [
      { issue: 6, state: "triage" },
      { issue: 9, state: "triage" },
      { issue: 3, state: "building" },
      { issue: 4, state: "building" },
    ]);
    // The history is read only for an issue that has no assignee and is old enough.
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      historyCallFor(6),
      historyCallFor(9),
      claimedListCall("factory:building"),
      historyCallFor(3),
      historyCallFor(4),
    ]);
  }),
);

it.effect("unassignedClaims drops an issue whose label someone else added", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(
      reply(triage),
      reply(labelledBy("another-machine", "factory:triage")),
      reply(labelledBy("RawPhp", "factory:triage")),
      reply("[]"),
    );
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, [{ issue: 2, state: "triage" }]);
  }),
);

it.effect("unassignedClaims judges the newest event of the label in its state", () =>
  Effect.gen(function* () {
    const on = (at: string, by: string, label: string) => labelEvent("LabeledEvent", at, by, label);
    const building = '[{"number":5,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}]';
    // We labelled it first and a person labelled it again: not ours.
    const thenAPerson = eventsReply(
      [on(LABELED, "rawphp", "factory:building"), on(AFTER, "eve", "factory:building")],
      null,
      [],
    );
    const t = setup(reply("[]"), reply(building), reply(thenAPerson));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, []);
    // Labels of other names after ours do not count.
    const thenAnotherLabel = eventsReply(
      [on(LABELED, "rawphp", "factory:building"), on(AFTER, "eve", "bug")],
      null,
      [],
    );
    const t2 = setup(reply("[]"), reply(building), reply(thenAnotherLabel));
    assert.deepStrictEqual((yield* t2.ok(scan(t2))).claims, [{ issue: 5, state: "building" }]);
  }),
);

it.effect("unassignedClaims drops an issue with no label event in its history", () =>
  Effect.gen(function* () {
    const triage = '[{"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}]';
    const t = setup(reply(triage), reply(eventsReply([], null, [])), reply("[]"));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, []);
  }),
);

it.effect("unassignedClaims reads no history for an issue the pass knows a run for", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(reply(triage), reply(labelledBy("rawphp", "factory:triage")), reply("[]"));
    const found = yield* t.ok(scan(t, new Set([1])));
    assert.deepStrictEqual(found.claims, [{ issue: 2, state: "triage" }]);
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      historyCallFor(2),
      claimedListCall("factory:building"),
    ]);
  }),
);

it.effect(
  "unassignedClaims remembers an issue judged not the factory's while updatedAt is unchanged",
  () =>
    Effect.gen(function* () {
      const listing = (updatedAt1: string) => `[
        {"number":1,"assignees":[],"updatedAt":"${updatedAt1}"},
        {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
      ]`;
      const other = labelledBy("another-machine", "factory:triage");
      const ours = labelledBy("rawphp", "factory:triage");
      const memo = new ClaimMemo();
      const histories = (t: ReturnType<typeof setup>) =>
        t.calls().filter((args) => args[0] === "api" && args[1] === "graphql");
      const t1 = setup(
        reply(listing("2026-10-07T00:00:00Z")),
        reply(other),
        reply(ours),
        reply("[]"),
      );
      yield* t1.ok(scan(t1, new Set<number>(), memo));
      assert.deepStrictEqual(histories(t1), [historyCallFor(1), historyCallFor(2)]);
      // Issue 1 was not ours and has not changed; issue 2 was ours, so it is read again.
      const t2 = setup(reply(listing("2026-10-07T00:00:00Z")), reply(ours), reply("[]"));
      const second = yield* t2.ok(scan(t2, new Set<number>(), memo));
      assert.deepStrictEqual(histories(t2), [historyCallFor(2)]);
      assert.deepStrictEqual(second.claims, [{ issue: 2, state: "triage" }]);
      // Issue 1 changed, so its judgement no longer stands.
      const t3 = setup(
        reply(listing("2026-10-07T01:00:00Z")),
        reply(other),
        reply(ours),
        reply("[]"),
      );
      yield* t3.ok(scan(t3, new Set<number>(), memo));
      assert.deepStrictEqual(histories(t3), [historyCallFor(1), historyCallFor(2)]);
    }),
);

it.effect("unassignedClaims: a history read that fails is an error for that issue only", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(
      reply(triage),
      fail(1, "boom"),
      reply(labelledBy("rawphp", "factory:triage")),
      reply("[]"),
    );
    const found = yield* t.ok(scan(t));
    assert.deepStrictEqual(found.claims, [{ issue: 2, state: "triage" }]);
    assert.strictEqual(found.unread.length, 1);
    const unread = found.unread[0]!;
    assert.strictEqual(unread.issue, 1);
    assert.strictEqual(unread.error._tag, "GitHubFailed");
    assert.deepStrictEqual(
      unread.error._tag === "GitHubFailed" ? unread.error.args : [],
      historyCallFor(1),
    );
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      historyCallFor(1),
      historyCallFor(2),
      claimedListCall("factory:building"),
    ]);
  }),
);

it.effect("unassignedClaims skips an issue whose time is not GitHub's form", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"yesterday"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(reply(triage), reply(labelledBy("rawphp", "factory:triage")), reply("[]"));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, [{ issue: 2, state: "triage" }]);
    assert.deepStrictEqual(t.calls()[1], historyCallFor(2));
  }),
);

it.effect("unassignedClaims refuses a before that is not GitHub's form, with no call", () =>
  Effect.gen(function* () {
    const t = setup();
    const error = yield* t.err(
      t.github.unassignedClaims(
        "2026-10-08T02:00:00.000Z",
        "rawphp",
        new Set<number>(),
        new ClaimMemo(),
      ),
    );
    assert.strictEqual(error._tag, "GitHubParse");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

it.effect("newestFactoryComment is the newest marked comment, without the marker", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        '[{"id":1,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"first\\n\\n<!-- softfac -->"},{"id":2,"user":{"login":"eve"},"created_at":"2026-10-04T10:14:16Z","body":"a person"},{"id":3,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:15:16Z","body":"status\\n\\n<!-- softfac:status -->"},{"id":4,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:16:16Z","body":"newest\\r\\nline  \\r\\n\\r\\n<!-- softfac -->  \\n"}]',
      ),
    );
    const found = yield* t.ok(t.github.newestFactoryComment(6));
    assert.deepStrictEqual(found, { body: "newest\nline", createdAt: "2026-10-04T10:16:16Z" });
    assert.deepStrictEqual(t.calls(), [listCommentsCall]);
  }),
);

it.effect(
  "newestFactoryComment is null with no marked comment, and empty when GitHub gives no time",
  () =>
    Effect.gen(function* () {
      const t = setup(reply('[{"id":2,"user":{"login":"eve"},"body":"a person"}]'));
      assert.strictEqual(yield* t.ok(t.github.newestFactoryComment(6)), null);
      const t2 = setup(reply('[{"id":1,"user":null,"body":"x\\n<!-- softfac -->"}]'));
      assert.deepStrictEqual(yield* t2.ok(t2.github.newestFactoryComment(6)), {
        body: "x",
        createdAt: "",
      });
    }),
);
