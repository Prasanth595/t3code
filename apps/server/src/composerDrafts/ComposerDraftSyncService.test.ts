import { expect, it } from "@effect/vitest";
import { ComposerDraftSyncPutInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ComposerDraftSync from "./ComposerDraftSyncService.ts";

const decodePut = Schema.decodeUnknownEffect(ComposerDraftSyncPutInput);

it.effect("keeps the newer unsent draft and ignores a stale write", () =>
  Effect.gen(function* () {
    const service = yield* ComposerDraftSync.ComposerDraftSyncService;
    const newer = yield* decodePut({
      drafts: [
        {
          key: "thread:alpha",
          prompt: "from desktop",
          updatedAt: "2026-10-28T04:00:00.000Z",
          deleted: false,
          threadId: "alpha",
        },
      ],
    });
    expect((yield* service.put(newer)).accepted).toEqual(["thread:alpha"]);

    const stale = yield* decodePut({
      drafts: [
        {
          key: "thread:alpha",
          prompt: "from mobile, earlier",
          updatedAt: "2026-10-28T03:00:00.000Z",
          deleted: false,
          threadId: "alpha",
        },
      ],
    });
    expect((yield* service.put(stale)).accepted).toEqual([]);

    const events = Array.from(
      yield* service.subscribe().pipe(Stream.take(1), Stream.runCollect),
    );
    const snapshot = events[0];
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type === "snapshot") {
      expect(snapshot.drafts).toMatchObject([{ key: "thread:alpha", prompt: "from desktop" }]);
    }
  }).pipe(
    Effect.provide(ComposerDraftSync.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  ),
);
