import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RelayDb from "../db.ts";
import * as CloudflareApiPause from "./CloudflareApiPause.ts";

const TransactionConnection = Context.Service<unknown>("test/TransactionConnection");

// Records whether each statement would have joined the ambient transaction.
function makeFakeDb(joinedTransaction: Array<boolean>) {
  const statement = <A>(result: A) =>
    Effect.serviceOption(TransactionConnection).pipe(
      Effect.tap((connection) =>
        Effect.sync(() => joinedTransaction.push(Option.isSome(connection))),
      ),
      Effect.as(result),
    );
  return {
    $client: { transactionService: TransactionConnection },
    select: () => ({
      from: () => ({ where: () => ({ limit: () => statement([{ pausedUntilMs: 42 }]) }) }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => statement([]) }) }),
  } as unknown as RelayDb.RelayDb["Service"];
}

describe("CloudflareApiPause", () => {
  it.effect("reads and records the pause outside a surrounding transaction", () => {
    const joinedTransaction: Array<boolean> = [];
    return Effect.gen(function* () {
      const pause = yield* CloudflareApiPause.CloudflareApiPause;
      const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(TransactionConnection, "transaction-connection"));

      expect(yield* inTransaction(pause.pausedUntilMillis)).toBe(42);
      yield* inTransaction(pause.pauseUntil(1_000));

      expect(joinedTransaction).toEqual([false, false]);
    }).pipe(
      Effect.provide(
        CloudflareApiPause.layer.pipe(
          Layer.provide(Layer.succeed(RelayDb.RelayDb, makeFakeDb(joinedTransaction))),
        ),
      ),
    );
  });
});
