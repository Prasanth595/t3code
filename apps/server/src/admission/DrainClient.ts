/**
 * Restart-safe caller layer for the T01 turn-admission drain API.
 *
 * Implements the D181-SUP-T02 contract: call drain (refuse new turns),
 * poll status until draining=true and running=0, hand control to the
 * restart, then resume. `drainAndWait` resumes when it was the one that
 * drained, so a timeout or poll failure never leaves admission stuck
 * closed.
 *
 * Speaks the real T01 routes from orchestration-v2/AdmissionHttp.ts:
 *   GET  /api/local/admission/status   (orchestration:read)
 *   POST /api/local/admission/drain    (orchestration:operate)
 *   POST /api/local/admission/resume   (orchestration:operate)
 * and decodes the shared AdmissionStatus shape `{ draining, running,
 * queued }`. The server is loopback-only, so a non-loopback base URL is
 * rejected before any token is sent, mirroring cli/admission.ts.
 *
 * Effect style, like the neighbouring CLI: HTTP comes from the
 * HttpClient service and time from Clock, so tests inject a scripted
 * HttpClient layer instead of globals.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AdmissionStatus } from "../orchestration-v2/Admission.ts";

export type AdmissionDrainStatus = typeof AdmissionStatus.Type;
export type DrainOperation = "status" | "drain" | "resume";

/** Every failure of a single drain-API request, or of resume during cleanup. */
export class DrainRequestError extends Schema.TaggedError<DrainRequestError>()(
  "DrainRequestError",
  {
    operation: Schema.Literals(["status", "drain", "resume"]),
    reason: Schema.Literals(["config", "network", "rejected", "response"]),
    status: Schema.optional(Schema.Number),
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "config") {
      return `Admission ${this.operation} refused: base URL must be a loopback origin without credentials.`;
    }
    return (
      `Admission ${this.operation} failed (${this.reason}).` +
      (this.status !== undefined ? ` HTTP ${this.status}.` : "") +
      (this.code !== undefined ? ` code=${this.code}.` : "")
    );
  }
}

/** `waitIdle` gave up before the server reported draining with zero running. */
export class DrainTimeoutError extends Schema.TaggedError<DrainTimeoutError>()(
  "DrainTimeoutError",
  {
    timeoutMs: Schema.Number,
    lastStatus: Schema.optional(AdmissionStatus),
  },
) {
  override get message(): string {
    const last = this.lastStatus;
    return (
      `Admission did not idle within ${this.timeoutMs}ms` +
      (last === undefined
        ? "."
        : ` (last status: draining=${last.draining}, running=${last.running}).`)
    );
  }
}

export interface DrainClientOptions {
  /** Server origin, e.g. `http://127.0.0.1:4317`. Must be loopback. */
  readonly baseUrl: string;
  /** Bearer token supplier for the paired operator scopes; omit for fakes. */
  readonly getToken?: Effect.Effect<string | undefined>;
}

export interface DrainWaitOptions {
  /** Give up after this long. Defaults to 120s. */
  readonly timeoutMs?: number;
  /** Delay between status polls. Defaults to 500ms. */
  readonly pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 500;

/** Loopback hosts the T01 API accepts, mirroring cli/admission.ts. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const parseLoopbackOrigin = (baseUrl: string): Option.Option<string> => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return Option.none();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password
  ) {
    return Option.none();
  }
  return Option.some(url.origin);
};

const ErrorBody = Schema.Struct({ code: Schema.optional(Schema.String) });

const readErrorCode = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string | undefined> =>
  response.json.pipe(
    Effect.map((body) => Schema.decodeUnknownOption(ErrorBody)(body)),
    Effect.map((decoded) => Option.getOrUndefined(decoded)?.code),
    Effect.orElseSucceed(() => undefined),
  );

export class DrainClient {
  private readonly baseUrl: string;
  private readonly getToken: Effect.Effect<string | undefined>;

  constructor(options: DrainClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken ?? Effect.succeed(undefined);
  }

  private request(
    operation: DrainOperation,
  ): Effect.Effect<AdmissionDrainStatus, DrainRequestError, HttpClient.HttpClient> {
    const self = this;
    return Effect.gen(function* () {
      const origin = parseLoopbackOrigin(self.baseUrl);
      if (Option.isNone(origin)) {
        return yield* new DrainRequestError({ operation, reason: "config" });
      }
      const token = yield* self.getToken.pipe(
        Effect.mapError(
          (cause) => new DrainRequestError({ operation, reason: "config", cause }),
        ),
      );
      let request = HttpClientRequest.make(operation === "status" ? "GET" : "POST")(
        `${origin.value}/api/local/admission/${operation}`,
      ).pipe(HttpClientRequest.acceptJson);
      if (token !== undefined) {
        request = HttpClientRequest.setHeader(request, "Authorization", `Bearer ${token}`);
      }
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(request).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() => new DrainRequestError({ operation, reason: "network" })),
      );
      if (response.status !== 200) {
        return yield* new DrainRequestError({
          operation,
          reason: "rejected",
          status: response.status,
          code: yield* readErrorCode(response),
        });
      }
      return yield* HttpClientResponse.schemaBodyJson(AdmissionStatus)(response).pipe(
        Effect.mapError(() => new DrainRequestError({ operation, reason: "response" })),
      );
    });
  }

  /** Current admission state. */
  status(): Effect.Effect<AdmissionDrainStatus, DrainRequestError, HttpClient.HttpClient> {
    return this.request("status");
  }

  /** Refuse new turns. Rejects without side effects when the server refuses. */
  drain(): Effect.Effect<AdmissionDrainStatus, DrainRequestError, HttpClient.HttpClient> {
    return this.request("drain");
  }

  /** Reopen admission. Idempotent: safe to call when already open. */
  resume(): Effect.Effect<AdmissionDrainStatus, DrainRequestError, HttpClient.HttpClient> {
    return this.request("resume");
  }

  /**
   * Poll status until the server reports draining with zero running.
   * Queued work does not block: queued runs are preserved across restart.
   * A status that is not draining yet keeps waiting; only the deadline
   * raises DrainTimeoutError.
   */
  waitIdle(
    options: DrainWaitOptions = {},
  ): Effect.Effect<
    AdmissionDrainStatus,
    DrainRequestError | DrainTimeoutError,
    HttpClient.HttpClient
  > {
    const self = this;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    return Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
      let lastStatus: AdmissionDrainStatus | undefined;
      for (;;) {
        const current: AdmissionDrainStatus = yield* self.request("status");
        lastStatus = current;
        if (current.draining && current.running === 0) return current;
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* new DrainTimeoutError({ timeoutMs, lastStatus });
        }
        yield* Effect.sleep(Duration.millis(pollMs));
      }
    });
  }

  /**
   * Drain, then wait until idle. On timeout or poll failure, resumes when
   * this call observed an open gate before draining, so admission is never
   * left stuck closed by us. A rejected drain surfaces without resume.
   * Returns the idle status; the caller owns the restart-then-resume step.
   */
  drainAndWait(
    options: DrainWaitOptions = {},
  ): Effect.Effect<
    AdmissionDrainStatus,
    DrainRequestError | DrainTimeoutError,
    HttpClient.HttpClient
  > {
    const self = this;
    return Effect.gen(function* () {
      const before: AdmissionDrainStatus = yield* self.request("status");
      const ownsDrain = !before.draining;
      yield* self.request("drain");
      return yield* self.waitIdle(options).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!ownsDrain) return yield* error;
            yield* self.request("resume").pipe(
              Effect.mapError(
                (resumeError) =>
                  new DrainRequestError({
                    operation: "resume",
                    reason: resumeError.reason,
                    status: resumeError.status,
                    code: resumeError.code,
                    cause: error,
                  }),
              ),
            );
            return yield* error;
          }),
        ),
      );
    });
  }
}
