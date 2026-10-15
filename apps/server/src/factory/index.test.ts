import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { FactoryLayer } from "./index.ts";

const messageText = (message: unknown): string => {
  const first = Array.isArray(message) ? message[0] : message;
  return typeof first === "string" ? first : String(first);
};

it.effect("logs factory started exactly once when the layer is built", () =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make(({ message }) => {
      logs.push(messageText(message));
    });

    yield* Effect.scoped(Layer.build(FactoryLayer)).pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
    );

    assert.deepStrictEqual(logs, ["factory started"]);
  }),
);
