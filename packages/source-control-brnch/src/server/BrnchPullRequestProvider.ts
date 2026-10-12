import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderKind,
  TrimmedNonEmptyString,
  type PullRequestCapabilities,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { definition } from "../client/definition.ts";
import * as BrnchCli from "./brnchCli.ts";
import * as Json from "./brnchChangeJson.ts";

const KIND = SourceControlProviderKind.make("brnch");

/**
 * What the `brnch` CLI can do with a change. It has no text search, no draft command, and no
 * patch of a whole change, so the Code tab, reviews, and reviewer requests are not offered.
 */
const CAPABILITIES: PullRequestCapabilities = {
  diff: false,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: false,
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
};

/** Change list rows read per state; a listing past it reports itself truncated. */
const PAGE_SIZE = 100;
/** Where `brnch merge request` stopped short; any other state is queued or done. */
const FAILED_PROMOTION_STATES = new Set(["blocked", "failed", "cancelled"]);

/** `brnch auth status`; the handle is what authors read under, so the two compare directly. */
const AuthStatus = Schema.Struct({
  user: Schema.Struct({
    id: TrimmedNonEmptyString,
    handle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  }),
});

/**
 * Brnch states no per-change permissions, so everything the change's state allows is offered and
 * Brnch's own refusal says why when the viewer may not.
 */
function viewerPermissions(change: Json.BrnchChange): PullRequestViewerPermissions {
  return {
    actions:
      change.state === "draft"
        ? ["ready", "close"]
        : change.state === "open"
          ? ["merge", "close"]
          : change.state === "closed"
            ? ["reopen"]
            : [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
    updateMethods: [],
    editChangeRequest: false,
  };
}

type ChangeRef = ProviderRepositoryRef & { readonly number: number };

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cli = yield* BrnchCli.make;

  const failure = (operation: string, detail: string) =>
    new PullRequestProviderError({ provider: KIND, operation, reason: "failed", detail });

  const brnch = <A>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "cwd">,
    args: ReadonlyArray<string>,
    schema: Schema.Codec<A, unknown, never, never>,
    options: Pick<BrnchCli.BrnchRunInput, "stdin" | "resultExitCodes"> = {},
  ) =>
    cli.run({ operation, cwd: input.cwd, args, ...options }, schema).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: KIND,
            operation,
            reason: error.reason,
            detail: error.detail,
            cause: error,
          }),
      ),
    );

  /** `--repo` for a repository on brnch.io, refused before anything runs for any other host. */
  const repoArgs = (
    operation: string,
    input: ProviderRepositoryRef,
  ): Effect.Effect<ReadonlyArray<string>, PullRequestProviderError> =>
    input.host.toLowerCase() === BrnchCli.BRNCH_HOST &&
    BrnchCli.brnchRepositoryPath(input.repository) === input.repository
      ? Effect.succeed(["--repo", input.repository])
      : Effect.fail(failure(operation, "Brnch serves owner/name repositories on brnch.io."));

  const readChange = (operation: string, input: ChangeRef) =>
    repoArgs(operation, input).pipe(
      Effect.flatMap((repo) =>
        brnch(
          operation,
          input,
          ["change", "view", String(input.number), ...repo],
          Json.BrnchChange,
        ),
      ),
    );

  const unsupported = (operation: string) =>
    Effect.fail(failure(operation, `Brnch cannot ${operation} from T3 Code yet.`));

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer: (input) =>
      brnch("getViewer", input, ["auth", "status"], AuthStatus).pipe(
        Effect.map((status) => status.user.handle ?? status.user.id),
      ),
    listChangeRequests: Effect.fn("BrnchPullRequestProvider.listChangeRequests")(function* (input) {
      const repo = yield* repoArgs("listChangeRequests", input);
      const limit = Math.max(1, Math.min(input.limit, PAGE_SIZE));
      // Brnch keeps drafts apart from open changes; both are open here.
      const states =
        input.state === "all" ? [null] : input.state === "open" ? ["open", "draft"] : [input.state];
      const pages = yield* Effect.forEach(
        states,
        (state) =>
          brnch(
            "listChangeRequests",
            input,
            [
              "change",
              "list",
              ...repo,
              "--limit",
              String(limit),
              ...(state === null ? [] : ["--state", state]),
            ],
            Json.BrnchChanges,
          ),
        { concurrency: 2 },
      );
      const changes = pages
        .flatMap((page) => page.items)
        .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at));
      return {
        items: changes
          .slice(0, limit)
          .map((change) => Json.toProviderChangeRequest(change, input.repository)),
        truncated: changes.length > limit || pages.some((page) => page.next_cursor !== null),
        continues: false,
      };
    }),
    getChangeRequest: (input) =>
      readChange("getChangeRequest", input).pipe(
        Effect.map((change) => ({
          ...Json.toProviderChangeRequest(change, input.repository),
          headSha: change.current_revision.head_oid,
          body: change.description,
          changedFiles: 0,
          mergedAt: change.merged?.at ?? null,
          closedAt: null,
          reviewers: [],
          checks: [],
          mergeCapabilities: { merge: true, squash: true, rebase: true },
          viewerPermissions: viewerPermissions(change),
        })),
      ),
    getChangeRequestActivity: Effect.fn("BrnchPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const repo = yield* repoArgs("getChangeRequestActivity", input);
        const threads = yield* brnch(
          "getChangeRequestActivity",
          input,
          ["review", "threads", String(input.number), ...repo, "--limit", String(PAGE_SIZE)],
          Json.BrnchThreads,
        );
        return Json.toActivity(threads);
      },
    ),
    getViewerPermissions: (input) =>
      readChange("getViewerPermissions", input).pipe(Effect.map(viewerPermissions)),
    getDiff: () => unsupported("getDiff"),
    runAction: Effect.fn("BrnchPullRequestProvider.runAction")(function* (input) {
      const repo = yield* repoArgs(input.action, input);
      const number = String(input.number);
      switch (input.action) {
        case "ready":
        case "close":
        case "reopen":
          yield* brnch(
            input.action,
            input,
            ["change", input.action, number, ...repo],
            Json.BrnchChange,
          );
          return;
        case "merge": {
          // A blocked promotion exits 7 with the promotion as its answer, blockers included.
          const promotion = yield* brnch(
            "merge",
            input,
            ["merge", "request", number, ...repo, "--strategy", input.mergeMethod ?? "merge"],
            Json.BrnchPromotion,
            { resultExitCodes: [7] },
          );
          if (FAILED_PROMOTION_STATES.has(promotion.state))
            return yield* failure(
              "merge",
              promotion.blockers.map((blocker) => blocker.message).join(" ") ||
                promotion.error ||
                `Brnch's merge was ${promotion.state}.`,
            );
          return;
        }
        default:
          return yield* unsupported(input.action);
      }
    }),
    // A remark on the change itself, which does not hold up its merge as a review thread would.
    comment: Effect.fn("BrnchPullRequestProvider.comment")(function* (input) {
      const repo = yield* repoArgs("comment", input);
      yield* brnch(
        "comment",
        input,
        ["review", "comment", String(input.number), ...repo, "--body", "-", "--non-blocking"],
        Schema.Unknown,
        { stdin: input.body },
      );
    }),
    submitReview: () => unsupported("submitReview"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: () => unsupported("setThreadResolution"),
  };
  return provider;
});
