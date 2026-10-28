import {
  ComposerDraftSyncError,
  ComposerDraftSyncEvent,
  SyncedComposerDraft,
  type ComposerDraftSyncKey,
  type ComposerDraftSyncPutInput,
  type ComposerDraftSyncPutResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

const MAX_LIVE_DRAFTS = 200;
const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const decodeDraft = Schema.decodeUnknownEffect(SyncedComposerDraft);
const encodeDraft = Schema.encodeSync(SyncedComposerDraft);
const isDraftError = Schema.is(ComposerDraftSyncError);

interface DraftRow {
  readonly draft_key: string;
  readonly updated_at: string;
  readonly payload_json: string;
}

export class ComposerDraftSyncService extends Context.Service<
  ComposerDraftSyncService,
  {
    readonly subscribe: () => Stream.Stream<ComposerDraftSyncEvent, ComposerDraftSyncError>;
    readonly put: (
      input: ComposerDraftSyncPutInput,
    ) => Effect.Effect<ComposerDraftSyncPutResult, ComposerDraftSyncError>;
  }
>()("t3/composerDrafts/ComposerDraftSyncService") {}

const draftError = (message: string) => new ComposerDraftSyncError({ message });

const readDrafts = Effect.fn("ComposerDraftSyncService.readDrafts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<DraftRow>`
    SELECT draft_key, updated_at, payload_json FROM composer_drafts ORDER BY updated_at ASC
  `;
  const drafts: SyncedComposerDraft[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json) as unknown;
    } catch (cause) {
      yield* Effect.logWarning("Skipping unreadable composer draft", {
        draftKey: row.draft_key,
        cause,
      });
      continue;
    }
    const decoded = yield* Effect.result(decodeDraft(parsed));
    if (Result.isSuccess(decoded)) drafts.push(decoded.success);
    else
      yield* Effect.logWarning("Skipping undecodable composer draft", {
        draftKey: row.draft_key,
        cause: decoded.failure,
      });
  }
  return drafts;
});

export const layer = Layer.effect(
  ComposerDraftSyncService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.unbounded<ComposerDraftSyncEvent>();

    const pruneTombstones = Effect.fn("ComposerDraftSyncService.pruneTombstones")(function* () {
      const cutoff = new Date(Date.now() - TOMBSTONE_RETENTION_MS).toISOString();
      yield* sql`
        DELETE FROM composer_drafts
        WHERE deleted = 1 AND updated_at < ${cutoff}
      `;
    });

    const saveDrafts = Effect.fn("ComposerDraftSyncService.put")(function* (input: ComposerDraftSyncPutInput) {
      const accepted: ComposerDraftSyncKey[] = [];
      yield* pruneTombstones();
      for (const draft of input.drafts) {
        const wrote = yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ updated_at: string }>`
              SELECT updated_at FROM composer_drafts WHERE draft_key = ${draft.key}
            `;
            const previous = existing[0]?.updated_at ?? null;
            if (previous !== null && previous >= draft.updatedAt) return false;
            if (previous === null && !draft.deleted) {
              const [{ count }] = yield* sql<{ count: number }>`
                SELECT count(*) AS count FROM composer_drafts WHERE deleted = 0
              `;
              if (Number(count) >= MAX_LIVE_DRAFTS) {
                return yield* Effect.fail(draftError("Too many unsent drafts to sync."));
              }
            }
            const payload = JSON.stringify(encodeDraft(draft));
            const deleted = draft.deleted ? 1 : 0;
            if (previous === null) {
              yield* sql`
                INSERT INTO composer_drafts (draft_key, updated_at, deleted, payload_json)
                VALUES (${draft.key}, ${draft.updatedAt}, ${deleted}, ${payload})
              `;
            } else {
              yield* sql`
                UPDATE composer_drafts
                SET updated_at = ${draft.updatedAt}, deleted = ${deleted}, payload_json = ${payload}
                WHERE draft_key = ${draft.key} AND updated_at < ${draft.updatedAt}
              `;
            }
            return true;
          }),
        );
        if (wrote) {
          accepted.push(draft.key);
          yield* PubSub.publish(changes, { type: "upsert", draft });
        }
      }
      return { accepted };
    });
    const put: ComposerDraftSyncService["Service"]["put"] = (input) =>
      saveDrafts(input).pipe(
        Effect.mapError((cause) =>
          isDraftError(cause) ? cause : draftError("Could not save the unsent draft."),
        ),
      );

    const subscribe: ComposerDraftSyncService["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const drafts = yield* readDrafts();
          return Stream.concat(
            Stream.make({ type: "snapshot" as const, drafts }),
            Stream.fromSubscription(subscription),
          );
        }),
      ).pipe(Stream.mapError((cause) => draftError(`Could not sync composer drafts: ${cause}`)));

    return ComposerDraftSyncService.of({ subscribe, put });
  }),
);
