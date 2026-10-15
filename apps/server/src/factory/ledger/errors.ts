export type LedgerErrorKind =
  | "InvalidRunId"
  | "AlreadyExists"
  | "AlreadyFinished"
  | "NotFound"
  | "UnknownEvent"
  | "Io";

export type LedgerErrorInit =
  /** A run id or repo that does not have the shape `<owner>__<repo>__<issue>__<attempt>`. */
  | { readonly kind: "InvalidRunId"; readonly input: string; readonly reason: string }
  /** `create` found a file for that run already; it was left untouched. */
  | { readonly kind: "AlreadyExists"; readonly path: string }
  /** The run already wrote its `finished` line; nothing more can be appended. */
  | { readonly kind: "AlreadyFinished"; readonly path: string }
  /** There is no file for that run. */
  | { readonly kind: "NotFound"; readonly path: string }
  /** An event name that ledger.md does not list. Nothing was written. */
  | { readonly kind: "UnknownEvent"; readonly event: string }
  /** Reading or writing the file failed; `cause` is what the file system threw. */
  | { readonly kind: "Io"; readonly path: string; readonly cause: unknown };

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const messageOf = (init: LedgerErrorInit): string => {
  switch (init.kind) {
    case "InvalidRunId":
      return `invalid run id \`${init.input}\`: ${init.reason}`;
    case "AlreadyExists":
      return `run file ${init.path} already exists`;
    case "AlreadyFinished":
      return `run file ${init.path} is already finished`;
    case "NotFound":
      return `no run file at ${init.path}`;
    case "UnknownEvent":
      return `unknown event \`${init.event}\`: ledger.md does not list it`;
    case "Io":
      return `${init.path}: ${causeMessage(init.cause)}`;
  }
};

/** Why a ledger operation failed. The messages are the ones softfac's Rust `Display` prints. */
export class LedgerError extends Error {
  readonly kind: LedgerErrorKind;
  /** `InvalidRunId` only: the text that was refused. */
  readonly input?: string;
  /** `InvalidRunId` only: why. */
  readonly reason?: string;
  /** Every kind but `InvalidRunId` and `UnknownEvent`: the file concerned. */
  readonly path?: string;
  /** `UnknownEvent` only: the event name that was refused. */
  readonly event?: string;

  constructor(init: LedgerErrorInit) {
    super(messageOf(init), init.kind === "Io" ? { cause: init.cause } : undefined);
    this.name = "LedgerError";
    this.kind = init.kind;
    if (init.kind === "InvalidRunId") {
      this.input = init.input;
      this.reason = init.reason;
    } else if (init.kind === "UnknownEvent") {
      this.event = init.event;
    } else {
      this.path = init.path;
    }
  }
}

/** An `Io` error for `path`, keeping what the file system threw as the `cause`. */
export const ioError = (path: string, cause: unknown) =>
  new LedgerError({ kind: "Io", path, cause });

/** The `code` of an error thrown by `node:fs`, e.g. `ENOENT`. */
export const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
