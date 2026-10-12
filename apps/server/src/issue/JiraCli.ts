import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Why a TWG CLI run failed, in the terms the issue service acts on. Diagnostics are classified
 * here and never cross the RPC boundary, since TWG output can carry account details.
 */
export class JiraCliError extends Schema.TaggedError<JiraCliError>()("JiraCliError", {
  operation: Schema.String,
  reason: Schema.Literals(["missing-tool", "unauthenticated", "rate-limited", "failed"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `TWG CLI failed in ${this.operation}: ${this.detail}`;
  }
}

const DETAIL = {
  "missing-tool": "The Atlassian TWG CLI (twg) is not installed on this environment.",
  unauthenticated: "Run `twg login` on this environment to read Jira issues.",
  "rate-limited": "Jira is rate limiting requests. Try again shortly.",
  failed: "The Jira request failed. Check the Atlassian TWG CLI on this environment.",
} as const;

function classify(diagnostic: string): JiraCliError["reason"] {
  if (
    /\b(401|403)\b|AUTH_REQUIRED|unauthenticated|unauthorized|not (?:logged|signed) in/i.test(
      diagnostic,
    )
  )
    return "unauthenticated";
  if (/\b429\b|rate.?limit/i.test(diagnostic)) return "rate-limited";
  return "failed";
}

/**
 * The Atlassian TWG CLI (`twg`), which reads Jira with the login the user already made on this
 * environment. Every call names its site, so one environment can read several Jira sites.
 */
export class JiraCli extends Context.Service<
  JiraCli,
  {
    /** Runs `twg` with JSON output and returns stdout. `site` is omitted for site-less commands. */
    readonly run: (input: {
      readonly operation: string;
      readonly site?: string | undefined;
      readonly args: ReadonlyArray<string>;
    }) => Effect.Effect<string, JiraCliError>;
  }
>()("t3/issue/JiraCli") {}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const run: JiraCli["Service"]["run"] = Effect.fn("JiraCli.run")(function* ({
    operation,
    site,
    args,
  }) {
    const fail = (reason: JiraCliError["reason"], cause?: unknown) =>
      new JiraCliError({ operation, reason, detail: DETAIL[reason], cause });
    const result = yield* runner
      .run({
        command: "twg",
        args: [
          ...(site === undefined ? [] : ["--site", site]),
          "--output",
          "json",
          "--output-summary",
          "none",
          "--timeout-ms",
          "20000",
          ...args,
        ],
        timeout: "30 seconds",
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "error",
      })
      .pipe(
        Effect.catchTags({
          ProcessSpawnError: (cause) => Effect.fail(fail("missing-tool", cause)),
          ProcessTimeoutError: (cause) => Effect.fail(fail("failed", cause)),
          ProcessOutputLimitError: (cause) => Effect.fail(fail("failed", cause)),
          ProcessReadError: (cause) => Effect.fail(fail("failed", cause)),
          ProcessStdinError: (cause) => Effect.fail(fail("failed", cause)),
        }),
      );
    if (result.timedOut || result.stdoutTruncated || result.stdoutInvalidUtf8)
      return yield* fail("failed");
    if (result.code !== 0) return yield* fail(classify(`${result.stdout}\n${result.stderr}`));
    return result.stdout;
  });
  return JiraCli.of({ run });
});

export const layer = Layer.effect(JiraCli, make);
