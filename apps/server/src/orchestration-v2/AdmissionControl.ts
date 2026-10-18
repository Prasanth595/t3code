import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Admission from "./Admission.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** Operator operations over the same gate and queue that serve every dispatch path. */
export class AdmissionControl extends Context.Service<
  AdmissionControl,
  {
    readonly drain: Admission.Admission["Service"]["drain"];
    readonly status: Admission.Admission["Service"]["status"];
    readonly resume: Effect.Effect<
      typeof Admission.AdmissionStatus.Type,
      Admission.AdmissionStorageError | Orchestrator.OrchestratorV2Error
    >;
  }
>()("t3/orchestration-v2/AdmissionControl") {}

const make = Effect.gen(function* () {
  const admission = yield* Admission.Admission;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return AdmissionControl.of({
    drain: admission.drain,
    status: admission.status,
    resume: Effect.gen(function* () {
      yield* admission.resume;
      yield* orchestrator.resumeQueuedRuns;
      return yield* admission.status;
    }),
  });
});

export const layer = Layer.effect(AdmissionControl, make);
