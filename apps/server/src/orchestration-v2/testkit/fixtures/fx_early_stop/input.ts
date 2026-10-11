import { SIMPLE_PROMPT, TURN_INTERRUPT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/** Inbound label of the prompt response fx returns after session/cancel. */
const FX_EARLY_STOP_RESPONSE_LABEL = "response:session/prompt";

/**
 * Holds that response until Stop has been sent. fx 0.0.13 then answers the
 * prompt with stopReason cancelled. The follow-up was recorded in the same
 * live session, not spliced.
 */
export function fxEarlyStopInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: TURN_INTERRUPT_PROMPT },
      {
        type: "interrupt",
        targetRunIndex: 1,
        releaseLabel: FX_EARLY_STOP_RESPONSE_LABEL,
      },
      { type: "message", text: SIMPLE_PROMPT },
    ],
  };
}
