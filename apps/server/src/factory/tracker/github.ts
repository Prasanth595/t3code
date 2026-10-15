import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PROJECT_CONFIG_PATH } from "../config.ts";
import {
  STATES,
  stateColor,
  stateDescription,
  stateFromLabel,
  stateLabel,
  type State,
} from "../domain/lifecycle.ts";
import { FactoryProcess } from "../process.ts";

/**
 * GitHub issues, labels, comments and files through the `gh` CLI, ported from
 * softfac's github.rs. Every call runs `gh` through `FactoryProcess`, so a test
 * swaps in a fake that records argv and answers from a queue.
 */

/** How many issues one listing of a label reads; past this the oldest are left out. */
export const LIST_LIMIT = 200;
/** Ends every comment the factory posts, so it can tell its own comments from instructors'. */
export const MARKER = "<!-- softfac -->";
/** Ends the single status comment instead of {@link MARKER}. */
export const STATUS_MARKER = "<!-- softfac:status -->";
/** The most a file read through the contents API may be. A project config is a few lines. */
export const MAX_FILE_BYTES = 64 * 1024;

const GH_TIMEOUT_MS = 60_000;
const GH_OUTPUT_LIMIT = 8 * 1024 * 1024;
/** gh's stderr for the primary limit, the secondary limit, and a 429. */
const RATE_LIMITED = /API rate limit|secondary rate limit|HTTP 429/i;

// ---- errors ----

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const oneLine = (text: string): string => text.replaceAll("\r", "\\r").replaceAll("\n", "\\n");

/**
 * The command for error messages. Comment bodies (the value after `--body`, or a
 * `body=` raw field) are replaced by their size, and newlines are escaped, so one
 * error stays one line. The error's `args` keep everything.
 */
const command = (args: ReadonlyArray<string>): string => {
  const shown = ["gh"];
  let afterBodyFlag = false;
  for (const arg of args) {
    if (afterBodyFlag) shown.push(`<${utf8Bytes(arg)} bytes>`);
    else if (arg.startsWith("body=")) shown.push(`body=<${utf8Bytes(arg.slice(5))} bytes>`);
    else shown.push(oneLine(arg));
    afterBodyFlag = arg === "--body";
  }
  return shown.join(" ");
};

/** For a value shown in an error message. */
const quoted = (text: string): string => `"${oneLine(text)}"`;

const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * `gh` could not be started: not installed, not on PATH, not executable (the shell's
 * exit 127 or 126, with its stderr as the cause), or an argument with a NUL byte.
 */
export class GitHubSpawnError extends Schema.TaggedError<GitHubSpawnError>()("GitHubSpawnError", {
  args: Schema.Array(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `cannot start \`${command(this.args)}\`: ${causeText(this.cause)}`;
  }
}

/** `gh` ran and exited non-zero (status -1 when a signal ended it). */
export class GitHubFailed extends Schema.TaggedError<GitHubFailed>()("GitHubFailed", {
  args: Schema.Array(Schema.String),
  status: Schema.Number,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `\`${command(this.args)}\` exited with status ${this.status}: ${this.stderr.trimEnd()}`;
  }
}

/** `gh` was still running at the time limit and was killed with everything it started. */
export class GitHubTimedOut extends Schema.TaggedError<GitHubTimedOut>()("GitHubTimedOut", {
  args: Schema.Array(Schema.String),
  seconds: Schema.Number,
}) {
  override get message(): string {
    return `\`${command(this.args)}\` timed out after ${this.seconds} s`;
  }
}

/** `gh` printed more than `limit` bytes. Output is never cut short: stdout is parsed whole. */
export class GitHubOutputTooLarge extends Schema.TaggedError<GitHubOutputTooLarge>()(
  "GitHubOutputTooLarge",
  { args: Schema.Array(Schema.String), limit: Schema.Number },
) {
  override get message(): string {
    return `\`${command(this.args)}\` printed more than ${this.limit} bytes`;
  }
}

/** `gh` succeeded but its output was not what the call expected. */
export class GitHubParse extends Schema.TaggedError<GitHubParse>()("GitHubParse", {
  args: Schema.Array(Schema.String),
  expected: Schema.String,
}) {
  override get message(): string {
    return `\`${command(this.args)}\` returned unexpected output: ${this.expected}`;
  }
}

/**
 * `gh` failed because GitHub is rate limiting its login: the primary limit, the
 * secondary limit or an HTTP 429. Retry later.
 */
export class GitHubRateLimited extends Schema.TaggedError<GitHubRateLimited>()(
  "GitHubRateLimited",
  { args: Schema.Array(Schema.String), stderr: Schema.String },
) {
  override get message(): string {
    return `\`${command(this.args)}\` hit GitHub's rate limit: ${this.stderr.trim()}`;
  }
}

/** An argument was refused before any `gh` call: it could leave the path it is put in. */
export class GitHubInvalidArgument extends Schema.TaggedError<GitHubInvalidArgument>()(
  "GitHubInvalidArgument",
  { argument: Schema.String, expected: Schema.String },
) {
  override get message(): string {
    return `refused ${quoted(this.argument)} before calling gh: expected ${this.expected}`;
  }
}

export type GitHubError =
  | GitHubSpawnError
  | GitHubInvalidArgument
  | GitHubFailed
  | GitHubTimedOut
  | GitHubOutputTooLarge
  | GitHubParse
  | GitHubRateLimited;

/** GitHub saying the thing asked for is not there: `gh` failed with a 404. */
export const isNotFound = (error: GitHubError): boolean =>
  error._tag === "GitHubFailed" && error.stderr.includes("HTTP 404");

// ---- gh's JSON ----

const Login = Schema.Struct({ login: Schema.String });
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

const IssueSummaries = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    assignees: Schema.Array(Login),
  }),
);

const IssueView = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: OptionalText,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  assignees: Schema.Array(Login),
  state: Schema.Literals(["OPEN", "CLOSED"]),
  author: Schema.optional(Schema.NullOr(Login)),
});

const LabelsView = Schema.Struct({ labels: Schema.Array(Schema.Struct({ name: Schema.String })) });
const LabelRows = Schema.Array(Schema.Struct({ name: Schema.String }));

const CommentRows = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    user: Schema.optional(Schema.NullOr(Login)),
    body: OptionalText,
  }),
);

const RepoView = Schema.Struct({ default_branch: OptionalText });

const RefView = Schema.Struct({
  object: Schema.Struct({ sha: Schema.String, type: Schema.String }),
});

const FileView = Schema.Struct({
  type: Schema.String,
  encoding: OptionalText,
  size: Schema.Number,
  content: OptionalText,
});

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly assignees: ReadonlyArray<string>;
}

/** `cut` is set when the listing had more than {@link LIST_LIMIT} issues. */
export interface Listing<T> {
  readonly items: ReadonlyArray<T>;
  readonly cut: boolean;
}

export interface IssueDetail {
  readonly number: number;
  readonly title: string;
  /** "" for an issue with no description. */
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  /** The author's login; null when GitHub gives none (a deleted account). */
  readonly author: string | null;
  /** The lifecycle state of the one `factory:*` label; null for none, several or an unknown one. */
  readonly state: State | null;
  /** GitHub has the issue closed. */
  readonly closed: boolean;
}

export interface BaseConfig {
  readonly branch: string;
  readonly tip: string;
  readonly text: string;
}

// ---- parsing helpers ----

const isJsonSpace = (char: string): boolean =>
  char === " " || char === "\n" || char === "\r" || char === "\t";

/**
 * Splits text holding several top-level JSON values (`gh --paginate` prints one
 * array per page) into the text of each. Brackets and quotes inside strings do
 * not count. A value that is cut short comes back as is, for the decoder to refuse.
 */
const splitJsonValues = (text: string): Array<string> => {
  const values: Array<string> = [];
  let i = 0;
  while (true) {
    while (i < text.length && isJsonSpace(text[i]!)) i++;
    if (i >= text.length) return values;
    const start = i;
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const char = text[i]!;
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') {
          inString = false;
          if (depth === 0) {
            i++;
            break;
          }
        }
      } else if (char === '"') inString = true;
      else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") {
        depth--;
        if (depth <= 0) {
          i++;
          break;
        }
      } else if (depth === 0 && isJsonSpace(char)) break;
    }
    values.push(text.slice(start, i));
  }
};

/**
 * Standard base64 as GitHub's contents API writes it: wrapped with newlines,
 * padded with `=`. Null for anything else, including data after padding and
 * padding that does not fit the length.
 */
const decodeBase64 = (text: string): Uint8Array | null => {
  const out: Array<number> = [];
  let bits = 0;
  let have = 0;
  let padding = 0;
  for (const char of text) {
    let value: number;
    if (char >= "A" && char <= "Z") value = char.charCodeAt(0) - 65;
    else if (char >= "a" && char <= "z") value = char.charCodeAt(0) - 97 + 26;
    else if (char >= "0" && char <= "9") value = char.charCodeAt(0) - 48 + 52;
    else if (char === "+") value = 62;
    else if (char === "/") value = 63;
    else if (char === "=") {
      padding++;
      continue;
    } else if (char === "\n" || char === "\r") continue;
    else return null;
    // Nothing may follow padding.
    if (padding > 0) return null;
    bits = (bits << 6) | value;
    have += 6;
    if (have >= 8) {
      have -= 8;
      out.push((bits >> have) & 0xff);
      bits &= (1 << have) - 1;
    }
  }
  // What is left over is padding bits, which must be zero, and the padding must fit.
  const fits =
    (have === 0 && padding === 0) || (have === 4 && padding === 2) || (have === 2 && padding === 1);
  return fits && bits === 0 ? Uint8Array.from(out) : null;
};

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** A branch name as a path under `refs/heads/` in the API; null for a name that could leave it. */
const encodeBranch = (branch: string): string | null => {
  if (branch.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  let out = "";
  for (const byte of new TextEncoder().encode(branch)) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~/]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

const isPlainSegment = (part: string): boolean =>
  part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part);

const isCommitId = (text: string): boolean => /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(text);

const withMarker = (body: string, marker: string): string => `${body}\n\n${marker}`;

// ---- the client ----

export interface GitHubOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** The `gh` login directory (`GH_CONFIG_DIR`) the calls run as. */
  readonly ghConfigDir: string;
}

type GitHubEffect<A> = Effect.Effect<A, GitHubError, FactoryProcess>;

export const makeGitHub = (options: GitHubOptions) => {
  const { repo } = options;

  /** Runs `gh` and returns stdout, or the typed error. */
  const gh = (args: ReadonlyArray<string>): GitHubEffect<string> =>
    Effect.gen(function* () {
      // Node's own spawn error quotes the offending argument, which could be a hidden comment body.
      if (args.some((arg) => arg.includes("\u0000"))) {
        return yield* new GitHubSpawnError({
          args,
          cause: new Error("argument contains a NUL byte"),
        });
      }
      const factoryProcess = yield* FactoryProcess;
      const result = yield* factoryProcess
        .run({
          command: "gh",
          args,
          env: { GH_CONFIG_DIR: options.ghConfigDir },
          timeoutMs: GH_TIMEOUT_MS,
          tailBytes: GH_OUTPUT_LIMIT,
          separateStderr: true,
        })
        .pipe(Effect.mapError((error) => new GitHubSpawnError({ args, cause: error.cause })));
      if (result.timedOut) {
        return yield* new GitHubTimedOut({ args, seconds: GH_TIMEOUT_MS / 1000 });
      }
      if (result.truncated) {
        return yield* new GitHubOutputTooLarge({ args, limit: GH_OUTPUT_LIMIT });
      }
      // The wrapper shell's "command not found" and "not executable"; gh itself never exits so.
      if (result.exitCode === 127 || result.exitCode === 126) {
        const why = result.stderrTail.trim() || `the shell exited with status ${result.exitCode}`;
        return yield* new GitHubSpawnError({ args, cause: new Error(why) });
      }
      if (result.exitCode !== 0) {
        if (RATE_LIMITED.test(result.stderrTail)) {
          return yield* new GitHubRateLimited({ args, stderr: result.stderrTail });
        }
        return yield* new GitHubFailed({
          args,
          status: result.exitCode ?? -1,
          stderr: result.stderrTail,
        });
      }
      return result.tail;
    });

  const parseError = (args: ReadonlyArray<string>, expected: string) =>
    new GitHubParse({ args, expected });

  /** Decodes `text` as JSON of the shape `schema`; the schema's complaint joins `expected`. */
  const decode = <T, E>(
    schema: Schema.Codec<T, E>,
    args: ReadonlyArray<string>,
    expected: string,
    text: string,
  ): GitHubEffect<T> =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((error) =>
        parseError(args, `${expected} (${String(error.message).replaceAll(/\s+/g, " ")})`),
      ),
    );

  /** Runs `gh` and decodes its stdout as JSON of the shape `schema`. */
  const ghJson = <T, E>(
    args: ReadonlyArray<string>,
    schema: Schema.Codec<T, E>,
    expected: string,
  ): GitHubEffect<T> =>
    gh(args).pipe(Effect.flatMap((stdout) => decode(schema, args, expected, stdout)));

  /**
   * Runs `gh api --paginate` and collects the rows of every JSON array in stdout:
   * gh prints either one merged array or one array per page.
   */
  const ghPages = <T, E>(
    args: ReadonlyArray<string>,
    schema: Schema.Codec<ReadonlyArray<T>, E>,
    expected: string,
  ): GitHubEffect<Array<T>> =>
    Effect.gen(function* () {
      const pages = splitJsonValues(yield* gh(args));
      if (pages.length === 0) {
        return yield* parseError(args, `${expected} (output was empty)`);
      }
      const rows: Array<T> = [];
      for (const page of pages) rows.push(...(yield* decode(schema, args, expected, page)));
      return rows;
    });

  const repoArgs = (parts: ReadonlyArray<string>): Array<string> => [...parts, "--repo", repo];

  const listIssues = (state: State): GitHubEffect<Listing<IssueSummary>> =>
    Effect.gen(function* () {
      const args = [
        ...repoArgs(["issue", "list"]),
        "--state",
        "open",
        "--label",
        stateLabel(state),
        "--limit",
        String(LIST_LIMIT + 1),
        "--json",
        "number,title,assignees",
      ];
      const raw = yield* ghJson(args, IssueSummaries, "a JSON array of issues");
      return {
        items: raw.slice(0, LIST_LIMIT).map((item) => ({
          number: item.number,
          title: item.title,
          assignees: item.assignees.map((assignee) => assignee.login),
        })),
        cut: raw.length > LIST_LIMIT,
      };
    });

  const issue = (number: number): GitHubEffect<IssueDetail> =>
    Effect.gen(function* () {
      const args = [
        ...repoArgs(["issue", "view", String(number)]),
        "--json",
        "number,title,body,labels,assignees,state,author",
      ];
      const raw = yield* ghJson(args, IssueView, "an object describing an issue");
      const labels = raw.labels.map((label) => label.name);
      const factory = labels.filter((name) => name.startsWith("factory:"));
      return {
        number: raw.number,
        title: raw.title,
        body: raw.body ?? "",
        labels,
        assignees: raw.assignees.map((assignee) => assignee.login),
        author: raw.author?.login ?? null,
        state: factory.length === 1 ? (stateFromLabel(factory[0]!) ?? null) : null,
        closed: raw.state === "CLOSED",
      };
    });

  /** Moves the issue to `state`: adds its label, removes every other `factory:*` label, touches nothing else. */
  const setState = (number: number, state: State): GitHubEffect<void> =>
    Effect.gen(function* () {
      const label = stateLabel(state);
      const view = [...repoArgs(["issue", "view", String(number)]), "--json", "labels"];
      const current = yield* ghJson(view, LabelsView, "an object with `labels`");
      const names = current.labels.map((l) => l.name);
      const present = names.includes(label);
      const stale = names.filter((name) => name.startsWith("factory:") && name !== label);
      if (present && stale.length === 0) return;
      const edit = repoArgs(["issue", "edit", String(number)]);
      if (!present) edit.push("--add-label", label);
      for (const name of stale) edit.push("--remove-label", name);
      yield* gh(edit);
    });

  const assign = (number: number, user: string): GitHubEffect<void> =>
    gh([...repoArgs(["issue", "edit", String(number)]), "--add-assignee", user]).pipe(
      Effect.asVoid,
    );

  const unassign = (number: number, user: string): GitHubEffect<void> =>
    gh([...repoArgs(["issue", "edit", String(number)]), "--remove-assignee", user]).pipe(
      Effect.asVoid,
    );

  /** Posts a comment on the issue, ending with the factory marker. */
  const postComment = (number: number, body: string): GitHubEffect<void> =>
    gh([
      ...repoArgs(["issue", "comment", String(number)]),
      "--body",
      withMarker(body, MARKER),
    ]).pipe(Effect.asVoid);

  /**
   * Writes the issue's single status comment: edits `user`'s existing one in place,
   * or creates it. Only a comment by `user` ending with the status marker counts, so
   * nobody else can take it over. A list-then-write, so concurrent callers could
   * still create two.
   */
  const upsertStatusComment = (number: number, user: string, body: string): GitHubEffect<void> =>
    Effect.gen(function* () {
      const list = ["api", `repos/${repo}/issues/${number}/comments`, "--paginate"];
      const existing = yield* ghPages(list, CommentRows, "JSON arrays of comments");
      const status = existing.find(
        (comment) =>
          comment.user?.login.toLowerCase() === user.toLowerCase() &&
          (comment.body ?? "").trimEnd().endsWith(STATUS_MARKER),
      );
      const text = withMarker(body, STATUS_MARKER);
      if (status === undefined) {
        yield* gh([...repoArgs(["issue", "comment", String(number)]), "--body", text]);
      } else {
        yield* gh([
          "api",
          "-X",
          "PATCH",
          `repos/${repo}/issues/comments/${status.id}`,
          "-f",
          `body=${text}`,
        ]);
      }
    });

  const labelNames = (): GitHubEffect<Array<string>> =>
    ghPages(
      ["api", `repos/${repo}/labels?per_page=100`, "--paginate"],
      LabelRows,
      "JSON arrays of labels",
    ).pipe(Effect.map((rows) => rows.map((row) => row.name)));

  /** `color` is six hex digits without the `#`. Creating a label that exists is an error. */
  const createLabel = (name: string, color: string, description: string): GitHubEffect<void> =>
    gh([
      ...repoArgs(["label", "create", name]),
      "--color",
      color,
      "--description",
      description,
    ]).pipe(Effect.asVoid);

  /** Creates the factory labels the repo lacks, in lifecycle order; returns their states. */
  const ensureLabels = (): GitHubEffect<Array<State>> =>
    Effect.gen(function* () {
      const existing = new Set(yield* labelNames());
      const created: Array<State> = [];
      for (const state of STATES) {
        if (existing.has(stateLabel(state))) continue;
        yield* createLabel(stateLabel(state), stateColor(state), stateDescription(state));
        created.push(state);
      }
      return created;
    });

  const defaultBranch = (): GitHubEffect<string> =>
    Effect.gen(function* () {
      const args = ["api", `repos/${repo}`];
      const view = yield* ghJson(args, RepoView, "an object with the repo's default branch");
      if (
        view.default_branch === undefined ||
        view.default_branch === null ||
        view.default_branch === ""
      ) {
        return yield* parseError(args, "an object with the repo's default branch (it had none)");
      }
      return view.default_branch;
    });

  /** The full commit id at the tip of `branch`. */
  const branchTip = (branch: string): GitHubEffect<string> =>
    Effect.gen(function* () {
      const encoded = encodeBranch(branch);
      if (encoded === null) {
        return yield* new GitHubInvalidArgument({
          argument: branch,
          expected: "a branch name without empty or dot segments",
        });
      }
      const args = ["api", `repos/${repo}/git/ref/heads/${encoded}`];
      const view = yield* ghJson(args, RefView, "an object with the commit the ref points at");
      if (view.object.type !== "commit" || !isCommitId(view.object.sha)) {
        return yield* parseError(args, "a commit and its full 40 or 64 digit id");
      }
      return view.object.sha;
    });

  /**
   * The text of the file at `path` in the commit `sha` (a full 40 or 64 digit id, never
   * a ref name), read through the contents API. Only a regular file of at most 64 KiB
   * whose content arrived whole is accepted; refusing the reply is a Parse error. `path` is
   * plain `/`-separated segments of letters, digits, `.`, `_` and `-`; anything else, or a
   * `sha` that is not a full id, is refused before the call.
   */
  const fileAt = (path: string, sha: string): GitHubEffect<string> =>
    Effect.gen(function* () {
      if (!path.split("/").every(isPlainSegment)) {
        return yield* new GitHubInvalidArgument({ argument: path, expected: "a plain file path" });
      }
      if (!isCommitId(sha)) {
        return yield* new GitHubInvalidArgument({ argument: sha, expected: "a full commit id" });
      }
      const args = ["api", `repos/${repo}/contents/${path}?ref=${sha}`];
      const file = yield* ghJson(args, FileView, "an object describing a file");
      const bad = (why: string) => parseError(args, `a regular file read whole (${why})`);
      if (file.type !== "file") return yield* bad("it is not a regular file");
      if (file.size > MAX_FILE_BYTES) return yield* bad("it is too big");
      if (file.encoding !== "base64") return yield* bad("its content did not come as base64");
      const bytes = decodeBase64(file.content ?? "");
      if (bytes === null) return yield* bad("its content is not valid base64");
      if (bytes.length !== file.size)
        return yield* bad("its content is not as long as its size says");
      const text = decodeUtf8(bytes);
      if (text === null) return yield* bad("it is not UTF-8");
      return text;
    });

  /**
   * The project config on the default branch: the branch, its tip and the file. The
   * file is read at that tip, so the three agree. A missing file is the 404 failure.
   */
  const baseConfig = (): GitHubEffect<BaseConfig> =>
    Effect.gen(function* () {
      const branch = yield* defaultBranch();
      const tip = yield* branchTip(branch);
      const text = yield* fileAt(PROJECT_CONFIG_PATH, tip);
      return { branch, tip, text };
    });

  return {
    listIssues,
    issue,
    setState,
    assign,
    unassign,
    postComment,
    upsertStatusComment,
    labelNames,
    createLabel,
    ensureLabels,
    defaultBranch,
    branchTip,
    fileAt,
    baseConfig,
  };
};
