// @effect-diagnostics nodeBuiltinImport:off -- the isolated SDK worker needs no-follow descriptors and bigint inode/time checks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  getSessionInfo,
  getSessionMessages,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 100_000;
const Entry = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    uuid: Schema.optionalKey(Schema.String),
    timestamp: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const decodeEntry = Schema.decodeUnknownSync(Entry);

export const ClaudeSnapshot = Schema.Struct({
  info: Schema.StructWithRest(
    Schema.Struct({
      sessionId: Schema.String,
      cwd: Schema.String,
      summary: Schema.String,
      lastModified: Schema.Number,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  messages: Schema.Array(
    Schema.StructWithRest(
      Schema.Struct({
        uuid: Schema.String,
        session_id: Schema.String,
        type: Schema.String,
        message: Schema.Unknown,
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
  entries: Schema.Array(Entry),
  transcript: Schema.Struct({ path: Schema.String, device: Schema.String, inode: Schema.String }),
  projectsRoot: Schema.Struct({ path: Schema.String, device: Schema.String, inode: Schema.String }),
  digest: Schema.String,
  sourceDigest: Schema.String,
});

export class ClaudeSnapshotError extends Schema.TaggedError<ClaudeSnapshotError>()(
  "ClaudeSnapshotError",
  {
    code: Schema.Literals([
      "history-unavailable",
      "history-incomplete",
      "history-changed",
      "identity-changed",
    ]),
  },
) {}

const identity = (path: string, stat: { dev: bigint; ino: bigint }) => ({
  path,
  device: String(stat.dev),
  inode: String(stat.ino),
});
const unchanged = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.nlink === right.nlink;

export async function captureClaudeSessionSnapshot(input: {
  readonly nativeId: string;
  readonly cwd: string;
  readonly projectsRoot: string;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.nativeId))
    throw new ClaudeSnapshotError({ code: "history-unavailable" });
  const root = await NodeFSP.realpath(input.projectsRoot);
  const rootStat = await NodeFSP.lstat(input.projectsRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || root !== input.projectsRoot)
    throw new ClaudeSnapshotError({ code: "identity-changed" });
  const cwd = await NodeFSP.realpath(input.cwd);
  if (cwd !== input.cwd) throw new ClaudeSnapshotError({ code: "identity-changed" });
  const matches: string[] = [];
  const directories = await NodeFSP.readdir(root, { withFileTypes: true });
  for (const directory of directories) {
    if (!directory.isDirectory()) {
      if (directory.isSymbolicLink()) throw new ClaudeSnapshotError({ code: "identity-changed" });
      continue;
    }
    const path = NodePath.join(root, directory.name, `${input.nativeId}.jsonl`);
    try {
      const stat = await NodeFSP.lstat(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
        throw new ClaudeSnapshotError({ code: "identity-changed" });
      matches.push(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  const path = matches[0];
  if (matches.length !== 1 || path === undefined)
    throw new ClaudeSnapshotError({ code: "history-unavailable" });
  const directoryPath = NodePath.dirname(path);
  const directoryBefore = await NodeFSP.lstat(directoryPath, { bigint: true });
  if ((await NodeFSP.realpath(path)) !== path)
    throw new ClaudeSnapshotError({ code: "identity-changed" });
  const file = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new ClaudeSnapshotError({ code: "identity-changed" });
    if (before.size > BigInt(MAX_SNAPSHOT_BYTES))
      throw new ClaudeSnapshotError({ code: "history-incomplete" });
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (!unchanged(before, after) || BigInt(length) !== before.size)
      throw new ClaudeSnapshotError({ code: "history-changed" });
    const bytes = buffer.subarray(0, length);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) throw new ClaudeSnapshotError({ code: "history-incomplete" });
    const lines = text.slice(0, -1).split("\n");
    if (lines.length > MAX_SNAPSHOT_ENTRIES)
      throw new ClaudeSnapshotError({ code: "history-incomplete" });
    const entries: SessionStoreEntry[] = [];
    const uuids = new Map<string, string>();
    for (const line of lines) {
      let entry;
      try {
        entry = decodeEntry(JSON.parse(line));
      } catch {
        throw new ClaudeSnapshotError({ code: "history-incomplete" });
      }
      if (
        (entry.sessionId !== undefined && entry.sessionId !== input.nativeId) ||
        (entry.cwd !== undefined && entry.cwd !== cwd)
      )
        throw new ClaudeSnapshotError({ code: "history-incomplete" });
      if (entry.uuid !== undefined) {
        const canonical = canonicalClaudeJson(entry);
        const previous = uuids.get(entry.uuid);
        if (previous !== undefined && previous !== canonical)
          throw new ClaudeSnapshotError({ code: "history-incomplete" });
        uuids.set(entry.uuid, canonical);
      }
      entries.push(entry);
    }
    const store: SessionStore = {
      load: async (key) => (key.sessionId === input.nativeId ? structuredClone(entries) : null),
      append: async () => {
        throw new ClaudeSnapshotError({ code: "history-incomplete" });
      },
    };
    const options = { dir: cwd, sessionStore: store };
    const info = await getSessionInfo(input.nativeId, options);
    if (info?.sessionId !== input.nativeId || info.cwd !== cwd)
      throw new ClaudeSnapshotError({ code: "history-unavailable" });
    const messages = await getSessionMessages(input.nativeId, {
      ...options,
      includeSystemMessages: true,
    });
    if (
      messages.length === 0 ||
      messages.some((message) => message.session_id !== input.nativeId || !uuids.has(message.uuid))
    )
      throw new ClaudeSnapshotError({ code: "history-incomplete" });
    const final = await NodeFSP.lstat(path, { bigint: true });
    const finalRoot = await NodeFSP.lstat(root, { bigint: true });
    const finalDirectory = await NodeFSP.lstat(directoryPath, { bigint: true });
    if (
      !unchanged(before, final) ||
      !unchanged(rootStat, finalRoot) ||
      !unchanged(directoryBefore, finalDirectory) ||
      (await NodeFSP.realpath(path)) !== path
    )
      throw new ClaudeSnapshotError({ code: "history-changed" });
    return Schema.decodeUnknownSync(ClaudeSnapshot)({
      info: { ...info, lastModified: Number(before.mtimeMs) },
      messages,
      entries,
      transcript: identity(path, before),
      projectsRoot: identity(root, rootStat),
      digest: NodeCrypto.createHash("sha256").update(canonicalClaudeJson(messages)).digest("hex"),
      sourceDigest: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await file.close();
  }
}

export function canonicalClaudeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalClaudeJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalClaudeJson(item)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Canonical JSON requires a JSON value.");
  return encoded;
}
