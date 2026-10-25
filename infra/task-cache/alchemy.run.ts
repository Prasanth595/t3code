import { adopt } from "alchemy/AdoptPolicy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import workerLayer, { Worker } from "./worker.ts";

export default Alchemy.Stack(
  "T3TaskCache",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url, workerName: worker.workerName };
  }).pipe(Effect.provide(workerLayer), adopt(true)),
);
