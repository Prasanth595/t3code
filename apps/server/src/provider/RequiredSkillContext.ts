// @effect-diagnostics nodeBuiltinImport:off
/**
 * RequiredSkillContext — caller-side delivery of required skill and reference
 * files for `delegate_task`.
 *
 * A caller names the files a child must have in full (a SKILL.md and its
 * references). Each entry declares its `length` (UTF-16 code units of the
 * text, i.e. `String.length`), `hash` (lowercase hex SHA-256 of that text as
 * UTF-8), and an opaque `revision` pointer. The server checks every entry
 * against those declarations once, before any thread, worktree, or provider
 * exists, and renders the verified text into the child's first message:
 *
 *   <task, unchanged>
 *
 *   required_references:
 *     - <path> | <inline|path> | <step>
 *
 *   === BEGIN REQUIRED CONTEXT kind=<skill-entry|reference> uri=<path> chars=<length> sha256=<hash> revision=<revision> ===
 *   <exactly `length` code units>
 *   === END REQUIRED CONTEXT uri=<path> ===
 *
 * The declaration is the task-envelope `required_references` form and the
 * fence is the one scripts/nofun/muse-acp.logic.mjs parses, so the Muse
 * bridge verifies the same length, hash, and revision again on its side.
 * Every other provider receives the same bytes as ordinary message text.
 *
 * Delivery is identity, not application: the child having the bytes says
 * nothing about it following them.
 *
 * @module provider/RequiredSkillContext
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS,
  ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_ENTRIES,
  type OrchestratorMcpRequiredContextEntry,
} from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Stands in for the path when a problem is with the list, the task text, or an unusable path. */
const DECLARATION = "<declaration>";
/** UTF-8 needs at most three bytes per UTF-16 code unit. */
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

export class RequiredContextBlockedError extends Schema.TaggedError<RequiredContextBlockedError>()(
  "RequiredContextBlockedError",
  {
    path: Schema.String,
    reason: Schema.String,
  },
) {
  static at(path: string, reason: string): RequiredContextBlockedError {
    return new RequiredContextBlockedError({ path, reason });
  }

  /** A problem with the request as a whole rather than one reference. */
  static forList(reason: string): RequiredContextBlockedError {
    return new RequiredContextBlockedError({ path: DECLARATION, reason });
  }

  override get message(): string {
    return `BLOCKED reference ${this.path}: ${this.reason}`;
  }
}

const isRequiredContextBlockedError = Schema.is(RequiredContextBlockedError);

/** What a caller declared about one reference, minus its text. */
export interface RequiredReference {
  readonly path: string;
  readonly delivery: "inline" | "path";
  readonly step: string;
  readonly length: number;
  readonly hash: string;
  readonly revision: string;
}

/** A declared reference whose text is in hand. Inline entries carry their own text; path entries do not until resolved. */
export interface DeclaredReference extends RequiredReference {
  readonly content: string | undefined;
}

export interface DeliveredReference extends RequiredReference {
  readonly content: string;
}

const utf8Sha256 = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const kindOf = (path: string): "skill-entry" | "reference" =>
  /(^|[/\\])SKILL\.md$/i.test(path) ? "skill-entry" : "reference";

/** Names a credential store or key file, by any path segment. */
const CREDENTIAL_SEGMENT =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.ssh|\.aws|\.gnupg|\.kube)$|\.(?:pem|key|p12|pfx)$/i;

const isCredentialShaped = (path: string): boolean =>
  path.split(/[/\\]/).some((segment) => CREDENTIAL_SEGMENT.test(segment));

/** A URL with a user or password in front of its host. */
const URL_WITH_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i;

const pathProblem = (path: string): string | undefined => {
  if (path.length === 0 || path.length > 1_024 || !path.isWellFormed()) {
    return "path must be 1-1024 characters of well-formed text";
  }
  if (/[\s|?\p{Cc}]/u.test(path)) {
    return "path must not contain whitespace, control characters, '|' or '?'";
  }
  if (URL_WITH_USERINFO.test(path)) return "path must not carry URL credentials";
  if (isCredentialShaped(path)) return "path names a credential-shaped file";
  return undefined;
};

const entryProblem = (entry: OrchestratorMcpRequiredContextEntry): string | undefined => {
  if (entry.step.trim().length === 0 || /[|\p{Cc}]/u.test(entry.step)) {
    return "step must be one non-empty line without '|'";
  }
  if (entry.delivery !== "inline" && entry.delivery !== "path") {
    return "delivery must be inline or path";
  }
  if (
    !Number.isInteger(entry.length) ||
    entry.length < 1 ||
    entry.length > ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS
  ) {
    return `length must be a whole number of UTF-16 code units from 1 to ${ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS}`;
  }
  if (!/^[0-9a-f]{64}$/.test(entry.hash)) {
    return "hash must be 64 lowercase hex characters (SHA-256 of the UTF-8 text)";
  }
  if (!/^\S{1,128}$/u.test(entry.revision) || /\p{Cc}/u.test(entry.revision)) {
    return "revision must be 1-128 characters without whitespace";
  }
  if (entry.delivery === "path") {
    return entry.content === undefined
      ? undefined
      : "path delivery must not carry content; the server reads the file";
  }
  return textProblem(entry, entry.content, "content");
};

/** Whether `text` is exactly the declared reference: whole, well-formed, and unaltered. */
const textProblem = (
  declared: Pick<RequiredReference, "length" | "hash">,
  text: string | undefined,
  label: "content" | "file",
): string | undefined => {
  if (text === undefined || text.length === 0) {
    return label === "content"
      ? "inline delivery needs the full content"
      : "file is empty or unreadable";
  }
  if (!text.isWellFormed()) return `${label} is not well-formed Unicode text`;
  if (text.length !== declared.length) {
    return `${label} has ${text.length} UTF-16 code units but length declares ${declared.length}; it was truncated, altered, or the declaration is stale`;
  }
  const actual = utf8Sha256(text);
  if (actual !== declared.hash) {
    return `${label} hashes to ${actual} but hash declares ${declared.hash}`;
  }
  return undefined;
};

/**
 * Checks the whole list and every inline entry without touching the
 * filesystem. The first problem found fails the call, naming that reference.
 */
export const normalizeRequiredContext = Effect.fnUntraced(function* (
  entries: ReadonlyArray<OrchestratorMcpRequiredContextEntry>,
) {
  if (entries.length < 1 || entries.length > ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_ENTRIES) {
    return yield* RequiredContextBlockedError.forList(
      `expected between 1 and ${ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_ENTRIES} required references`,
    );
  }
  const declared: Array<DeclaredReference> = [];
  for (const [index, entry] of entries.entries()) {
    const invalidPath = pathProblem(entry.path);
    const label = invalidPath === undefined ? entry.path : `requiredContext[${index}]`;
    const earlier = declared.find((reference) => reference.path === entry.path);
    const problem =
      invalidPath ??
      (earlier === undefined
        ? undefined
        : earlier.hash === entry.hash && earlier.revision === entry.revision
          ? "duplicate required reference declaration"
          : "conflicting declarations for the same path (different hash or revision)");
    if (problem !== undefined) return yield* RequiredContextBlockedError.at(label, problem);
    const invalid = entryProblem(entry);
    if (invalid !== undefined) return yield* RequiredContextBlockedError.at(label, invalid);
    declared.push({
      path: entry.path,
      delivery: entry.delivery,
      step: entry.step,
      length: entry.length,
      hash: entry.hash,
      revision: entry.revision,
      content: entry.delivery === "inline" ? entry.content : undefined,
    });
  }
  const total = declared.reduce((sum, reference) => sum + reference.length, 0);
  if (total > ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS) {
    return yield* RequiredContextBlockedError.forList(
      `required context totals ${total} UTF-16 code units, over the ${ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS} limit; nothing was truncated`,
    );
  }
  return declared as ReadonlyArray<DeclaredReference>;
});

/**
 * The structured list is the only declaration. Task text that already carries
 * a `required_references:` line or a fence would give the child two.
 */
export const assertTaskIsFreeOfRequiredContextMarkup = Effect.fnUntraced(function* (task: string) {
  if (/(^|\n)(?:required_references:|=== BEGIN REQUIRED CONTEXT )/.test(task)) {
    return yield* RequiredContextBlockedError.forList(
      "the task text already declares required_references or a required-context fence; pass those references in requiredContext instead",
    );
  }
});

const errnoReason = (cause: unknown): string => {
  switch ((cause as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT":
    case "ENOTDIR":
      return "does not exist in this thread's workspace; deliver it inline";
    case "EACCES":
    case "EPERM":
      return "is not readable";
    case "ELOOP":
      return "is a symbolic link";
    default:
      return "could not be read";
  }
};

/** Throws a {@link RequiredContextBlockedError} naming `path`, or lets an fs error through. */
const readWorkspaceText = async (
  workspaceRoot: string,
  reference: RequiredReference,
): Promise<string> => {
  const blocked = (reason: string) => RequiredContextBlockedError.at(reference.path, reason);
  const root = await NodeFSP.realpath(workspaceRoot);
  const requested = NodePath.resolve(root, reference.path);
  const resolved = await NodeFSP.realpath(requested);
  const relative = NodePath.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    throw blocked("resolves outside this thread's workspace");
  }
  if (isCredentialShaped(relative)) throw blocked("resolves to a credential-shaped file");
  const listed = await NodeFSP.lstat(resolved);
  if (!listed.isFile()) throw blocked("is not a regular file");
  if (listed.size === 0) throw blocked("is empty");
  if (listed.size > reference.length * MAX_UTF8_BYTES_PER_CODE_UNIT) {
    throw blocked(
      `is ${listed.size} bytes, more than the declared length of ${reference.length} code units can hold`,
    );
  }
  const handle = await NodeFSP.open(
    resolved,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== listed.ino ||
      opened.dev !== listed.dev ||
      opened.size !== listed.size
    ) {
      throw blocked("changed while it was being read");
    }
    const bytes = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (bytesRead === 0) throw blocked("ended before its recorded size");
      filled += bytesRead;
    }
    const settled = await handle.stat();
    if (settled.size !== opened.size || settled.mtimeMs !== opened.mtimeMs) {
      throw blocked("changed while it was being read");
    }
    if ((await NodeFSP.realpath(requested)) !== resolved) {
      throw blocked("was replaced while it was being read");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw blocked("is not valid UTF-8 text");
    }
  } finally {
    await handle.close();
  }
};

/**
 * Reads each `path` reference once from the caller's workspace and checks it
 * against its declaration; inline references pass through as supplied. A
 * caller names the workspace; paths never widen it, and symlinks that leave
 * it are refused. The returned text is what gets admitted: nothing reopens
 * these files afterwards, so a replay cannot change admitted bytes.
 */
export const resolveRequiredContext = Effect.fnUntraced(function* (input: {
  readonly references: ReadonlyArray<DeclaredReference>;
  /** The thread's bound workspace; undefined when none is known. */
  readonly workspaceRoot: string | undefined;
}) {
  const delivered: Array<DeliveredReference> = [];
  for (const reference of input.references) {
    if (reference.delivery === "inline") {
      if (reference.content === undefined) {
        return yield* RequiredContextBlockedError.at(
          reference.path,
          "inline delivery needs the full content",
        );
      }
      delivered.push({ ...reference, content: reference.content });
      continue;
    }
    const workspaceRoot = input.workspaceRoot;
    if (workspaceRoot === undefined) {
      return yield* RequiredContextBlockedError.at(
        reference.path,
        "no workspace is bound to this thread to read it from; deliver it inline",
      );
    }
    const content = yield* Effect.tryPromise({
      try: () => readWorkspaceText(workspaceRoot, reference),
      catch: (cause) =>
        isRequiredContextBlockedError(cause)
          ? cause
          : RequiredContextBlockedError.at(reference.path, errnoReason(cause)),
    });
    const problem = textProblem(reference, content, "file");
    if (problem !== undefined)
      return yield* RequiredContextBlockedError.at(reference.path, problem);
    delivered.push({ ...reference, content });
  }
  return delivered as ReadonlyArray<DeliveredReference>;
});

const declarationOf = (references: ReadonlyArray<RequiredReference>): string =>
  [
    "required_references:",
    ...references.map(
      (reference) => `  - ${reference.path} | ${reference.delivery} | ${reference.step}`,
    ),
  ].join("\n");

const fenceOpening = (reference: RequiredReference): string =>
  `=== BEGIN REQUIRED CONTEXT kind=${kindOf(reference.path)} uri=${reference.path} chars=${reference.length} sha256=${reference.hash} revision=${reference.revision} ===`;

const fenceClosing = (reference: RequiredReference): string =>
  `=== END REQUIRED CONTEXT uri=${reference.path} ===`;

/** The task exactly as given, then the declaration and one fence per reference, in caller order. */
export const renderTaskWithRequiredContext = (
  task: string,
  references: ReadonlyArray<DeliveredReference>,
): string =>
  [
    task,
    declarationOf(references),
    ...references.map(
      (reference) => `${fenceOpening(reference)}\n${reference.content}\n${fenceClosing(reference)}`,
    ),
  ].join("\n\n");

/**
 * Whether `prompt` is exactly what {@link renderTaskWithRequiredContext}
 * admitted for this task and these declarations. Each fence body is re-hashed
 * from the admitted prompt itself, so a retry is bound to the admitted bytes
 * without opening any file.
 */
export const admittedPromptMatches = (
  prompt: string,
  task: string,
  references: ReadonlyArray<RequiredReference>,
): boolean => {
  const head = `${task}\n\n${declarationOf(references)}\n\n`;
  if (!prompt.startsWith(head)) return false;
  let cursor = head.length;
  for (const [index, reference] of references.entries()) {
    const opening = `${fenceOpening(reference)}\n`;
    if (!prompt.startsWith(opening, cursor)) return false;
    const bodyStart = cursor + opening.length;
    const bodyEnd = bodyStart + reference.length;
    const closing = `\n${fenceClosing(reference)}`;
    if (!prompt.startsWith(closing, bodyEnd)) return false;
    if (utf8Sha256(prompt.slice(bodyStart, bodyEnd)) !== reference.hash) return false;
    cursor = bodyEnd + closing.length;
    if (index < references.length - 1) {
      if (!prompt.startsWith("\n\n", cursor)) return false;
      cursor += 2;
    }
  }
  return cursor === prompt.length;
};

/** Whether `prompt` carries a required-context section at all, matching or not. */
export const hasRequiredContextSection = (prompt: string): boolean =>
  prompt.includes("\n\nrequired_references:\n  - ");

/** The declared identities as one stable string, for keys that must change when any of them does. */
export const requiredContextBinding = (references: ReadonlyArray<RequiredReference>): string =>
  references
    .map((reference) =>
      [
        reference.path,
        reference.delivery,
        reference.step,
        reference.length,
        reference.hash,
        reference.revision,
      ].join("\u0001"),
    )
    .join("\u0002");

/**
 * Adapters that rewrite skill-shaped tokens in a message before sending it:
 * Cursor turns `$name` into `/name` for installed skills, Codex turns another
 * currency sigil (`€name`) into `$name`, and Claude turns `$name` into
 * `/name` and may invoke one, except inside a required-context fence, which
 * ClaudeSkillDispatch leaves alone (f2708d65df). The installed skill set is
 * only known per workspace at send time, so a skill-shaped token in text that
 * an adapter would rewrite is refused instead of risking bytes that no longer
 * match their length and hash. Remove an arm here when its adapter stops
 * rewriting that text.
 */
const rewritesSkillMentions = (driver: string, sigil: string): boolean => {
  switch (driver) {
    case "claudeAgent":
    case "cursor":
      return true;
    case "codex":
      return sigil !== "$";
    default:
      return false;
  }
};

export const assertSkillMentionBytesSurvive = Effect.fnUntraced(function* (
  references: ReadonlyArray<DeliveredReference>,
  driver: string,
) {
  for (const reference of references) {
    // What the child is sent for this reference. Claude's fence is protected,
    // so only the declaration line (path and step) is exposed to it.
    const declaration = declarationOf([reference]);
    const sent =
      driver === "claudeAgent"
        ? declaration
        : `${declaration}\n\n${fenceOpening(reference)}\n${reference.content}\n${fenceClosing(reference)}`;
    for (const match of sent.matchAll(SKILL_MENTION_PATTERN)) {
      const [token, leading = "", name = ""] = match;
      const sigil = token.slice(leading.length, token.length - name.length);
      if (!rewritesSkillMentions(driver, sigil)) continue;
      const shown = name.length > 48 ? `${name.slice(0, 48)}…` : name;
      return yield* RequiredContextBlockedError.at(
        reference.path,
        `the text contains the skill-shaped token '${sigil}${shown}', which the ${driver} adapter rewrites before sending, so the child would not receive the declared length, hash, and revision; reword that token in the source or delegate to a provider that sends text unchanged`,
      );
    }
  }
});
