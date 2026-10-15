import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Read-only contracts for the px0 code-viewer engine.
 *
 * px0 runs as a headless local HTTP server (a bundled Go binary) indexing one
 * workspace root. The T3 server spawns it per project and forwards these
 * requests over the typed WebSocket transport, so the Files surface gets px0's
 * fast index, search, Chroma highlighting, outline, and git diff without the
 * client talking HTTP to a second origin.
 *
 * Paths in these inputs are workspace-relative (px0 keys every request by its
 * own root, selected here via `cwd`).
 */

const PX0_PATH_MAX_LENGTH = 4096;

const Px0Cwd = TrimmedNonEmptyString.check(Schema.isMaxLength(PX0_PATH_MAX_LENGTH));
const Px0RelPath = TrimmedNonEmptyString.check(Schema.isMaxLength(PX0_PATH_MAX_LENGTH));

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export const Px0MetaInput = Schema.Struct({
  cwd: Px0Cwd,
});
export type Px0MetaInput = typeof Px0MetaInput.Type;

export const Px0MetaResult = Schema.Struct({
  root: Schema.String,
  name: Schema.String,
  files: Schema.Finite,
  ready: Schema.Boolean,
  git: Schema.Boolean,
  gitChanges: Schema.Finite,
  gitFiles: Schema.Array(Schema.String),
  lspServers: Schema.Array(Schema.String),
  version: Schema.String,
});
export type Px0MetaResult = typeof Px0MetaResult.Type;

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

export const Px0TreeInput = Schema.Struct({
  cwd: Px0Cwd,
  dir: Schema.String,
});
export type Px0TreeInput = typeof Px0TreeInput.Type;

export const Px0TreeChild = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  dir: Schema.Boolean,
  size: Schema.Finite,
});
export type Px0TreeChild = typeof Px0TreeChild.Type;

export const Px0TreeResult = Schema.Struct({
  dir: Schema.String,
  children: Schema.Array(Px0TreeChild),
});
export type Px0TreeResult = typeof Px0TreeResult.Type;

// ---------------------------------------------------------------------------
// find (fuzzy file open)
// ---------------------------------------------------------------------------

export const Px0FindInput = Schema.Struct({
  cwd: Px0Cwd,
  q: Schema.String,
  limit: Schema.optional(Schema.Finite),
});
export type Px0FindInput = typeof Px0FindInput.Type;

export const Px0FindResult = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  pos: Schema.Array(Schema.Finite),
});
export type Px0FindResult = typeof Px0FindResult.Type;

export const Px0FindResults = Schema.Struct({
  results: Schema.Array(Px0FindResult),
});
export type Px0FindResults = typeof Px0FindResults.Type;

// ---------------------------------------------------------------------------
// file
// ---------------------------------------------------------------------------

export const Px0FileInput = Schema.Struct({
  cwd: Px0Cwd,
  path: Px0RelPath,
  start: Schema.optional(Schema.Finite),
  count: Schema.optional(Schema.Finite),
});
export type Px0FileInput = typeof Px0FileInput.Type;

export const Px0FileLsp = Schema.Struct({
  server: Schema.String,
  state: Schema.String,
  missing: Schema.optional(Schema.String),
});
export type Px0FileLsp = typeof Px0FileLsp.Type;

export const Px0FileResult = Schema.Struct({
  path: Schema.String,
  lang: Schema.String,
  total: Schema.Finite,
  maxCols: Schema.Finite,
  start: Schema.Finite,
  /** Chroma-highlighted HTML line fragments; injected verbatim by the reader. */
  lines: Schema.Array(Schema.String),
  size: Schema.Finite,
  exact: Schema.Boolean,
  refine: Schema.Boolean,
  markdown: Schema.Boolean,
  diffAvailable: Schema.Boolean,
  /** Present and true when the file is an image; the text fields are then empty. */
  image: Schema.optional(Schema.Boolean),
  lsp: Schema.optional(Px0FileLsp),
});
export type Px0FileResult = typeof Px0FileResult.Type;

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

export const Px0TableInput = Schema.Struct({
  cwd: Px0Cwd,
  path: Px0RelPath,
});
export type Px0TableInput = typeof Px0TableInput.Type;

export const Px0TableRow = Schema.Struct({
  line: Schema.Finite,
  cells: Schema.Array(Schema.String),
});
export type Px0TableRow = typeof Px0TableRow.Type;

export const Px0TableResult = Schema.Struct({
  header: Schema.Array(Schema.String),
  headerLine: Schema.Finite,
  rows: Schema.Array(Px0TableRow),
  cols: Schema.Finite,
  truncated: Schema.Boolean,
});
export type Px0TableResult = typeof Px0TableResult.Type;

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export const Px0SearchInput = Schema.Struct({
  cwd: Px0Cwd,
  q: Schema.String,
  re: Schema.optional(Schema.Boolean),
  case: Schema.optional(Schema.Boolean),
  word: Schema.optional(Schema.Boolean),
  glob: Schema.optional(Schema.String),
});
export type Px0SearchInput = typeof Px0SearchInput.Type;

export const Px0Match = Schema.Struct({
  line: Schema.Finite,
  pre: Schema.String,
  mid: Schema.String,
  post: Schema.String,
  def: Schema.optional(Schema.Boolean),
});
export type Px0Match = typeof Px0Match.Type;

export const Px0FileMatches = Schema.Struct({
  path: Schema.String,
  matches: Schema.Array(Px0Match),
});
export type Px0FileMatches = typeof Px0FileMatches.Type;

export const Px0SearchResult = Schema.Struct({
  results: Schema.Array(Px0FileMatches),
  files: Schema.Finite,
  total: Schema.Finite,
  truncated: Schema.Boolean,
});
export type Px0SearchResult = typeof Px0SearchResult.Type;

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

export const Px0OutlineInput = Schema.Struct({
  cwd: Px0Cwd,
  path: Px0RelPath,
});
export type Px0OutlineInput = typeof Px0OutlineInput.Type;

export const Px0Symbol = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  line: Schema.Finite,
  indent: Schema.Finite,
});
export type Px0Symbol = typeof Px0Symbol.Type;

export const Px0OutlineResult = Schema.Struct({
  path: Schema.String,
  symbols: Schema.Array(Px0Symbol),
});
export type Px0OutlineResult = typeof Px0OutlineResult.Type;

// ---------------------------------------------------------------------------
// diff / gutter
// ---------------------------------------------------------------------------

export const Px0DiffInput = Schema.Struct({
  cwd: Px0Cwd,
  path: Px0RelPath,
});
export type Px0DiffInput = typeof Px0DiffInput.Type;

export const Px0DiffResult = Schema.Struct({
  path: Schema.String,
  diff: Schema.String,
  available: Schema.Boolean,
});
export type Px0DiffResult = typeof Px0DiffResult.Type;

export const Px0GutterResult = Schema.Struct({
  path: Schema.String,
  available: Schema.Boolean,
  added: Schema.Array(Schema.Finite),
  modified: Schema.Array(Schema.Finite),
  deleted: Schema.Array(Schema.Finite),
});
export type Px0GutterResult = typeof Px0GutterResult.Type;

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

function decodedPx0ErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class Px0Error extends Schema.TaggedError<Px0Error>()("Px0Error", {
  operation: Schema.String,
  cwd: Schema.optional(Schema.String),
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  // Structured diagnostics stay optional while the request context and a
  // human-readable message are always present. Matching the filesystem error
  // convention, the constructor only decorates the stored message.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly operation: string;
    readonly cwd?: string | undefined;
    readonly cause?: unknown;
  }) {
    super({
      ...props,
      message:
        decodedPx0ErrorMessage(props) ?? `px0 ${props.operation} failed for '${props.cwd ?? ""}'.`,
    } as Px0Error);
  }
}
