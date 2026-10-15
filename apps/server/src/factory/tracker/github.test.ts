import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PROJECT_CONFIG_PATH } from "../config.ts";
import { FactoryProcess, type RunInput, type RunResult, RunSpawnError } from "../process.ts";
import {
  GitHubFailed,
  GitHubOutputTooLarge,
  GitHubParse,
  GitHubRateLimited,
  GitHubSpawnError,
  GitHubTimedOut,
  LIST_LIMIT,
  MARKER,
  MAX_FILE_BYTES,
  STATUS_MARKER,
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
      assert.strictEqual(error._tag, "GitHubParse", branch);
      assert.deepStrictEqual(t.calls(), [], branch);
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
        assert.strictEqual(error._tag, "GitHubParse", `${path} ${sha}`);
        assert.deepStrictEqual(t.calls(), [], `${path} ${sha}`);
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

it.effect("a timed out gh is a timeout error", () =>
  Effect.gen(function* () {
    const t = setup(timedOut());
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubTimedOut");
    if (error._tag !== "GitHubTimedOut") return;
    assert.strictEqual(error.seconds, 60);
    assert.include(error.message, "timed out after 60 s");
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
  }),
);

// ---- rate limit ----

it.effect("only the rate limit is read as a rate limit", () =>
  Effect.gen(function* () {
    for (const stderr of [
      "GraphQL: API rate limit already exceeded for user ID 1.",
      "gh: API rate limit exceeded (HTTP 403)",
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
    new GitHubSpawnError({ args: ["--body"], cause: new Error("nope") }).message,
    "cannot start `gh --body`: nope",
  );
});
