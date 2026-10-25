import { adopt } from "alchemy/AdoptPolicy";
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Layer from "effect/Layer";
import { Observability } from "./observability.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import workerLayer, { Worker } from "./worker.ts";

export default Alchemy.Stack(
  "T3TaskCache",
  {
    providers: Axiom.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    const observability = yield* Observability;
    return {
      url: worker.url,
      workerName: worker.workerName,
      dashboard: observability.dashboard.uid,
    };
  }).pipe(Effect.provide(workerLayer), adopt(true)),
);
