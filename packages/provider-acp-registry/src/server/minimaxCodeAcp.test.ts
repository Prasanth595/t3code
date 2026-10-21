import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as EffectAcpErrors from "effect-acp/errors";

import { acpRegistryAgentFlavorExtras, isMinimaxCodeBusyFailure } from "./minimaxCodeAcp.ts";

const busyError = new EffectAcpErrors.AcpRequestError({
  code: -32603,
  errorMessage:
    "MiniMax Code Runtime failed: Session already has an active Turn. Use queue send to deliver the message after it.",
});

describe("isMinimaxCodeBusyFailure", () => {
  it("recognizes the turn lease rejection", () => {
    assert.isTrue(isMinimaxCodeBusyFailure(Cause.fail(busyError)));
  });

  it("ignores other request errors", () => {
    assert.isFalse(
      isMinimaxCodeBusyFailure(
        Cause.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: "MiniMax Code Runtime failed: the model exploded.",
          }),
        ),
      ),
    );
  });

  it("ignores transport errors", () => {
    assert.isFalse(
      isMinimaxCodeBusyFailure(
        Cause.fail(
          new EffectAcpErrors.AcpTransportError({
            method: "session/prompt",
            detail: "gone",
            cause: undefined,
          }),
        ),
      ),
    );
  });

  it("ignores interrupts", () => {
    assert.isFalse(isMinimaxCodeBusyFailure(Cause.interrupt()));
  });
});

describe("acpRegistryAgentFlavorExtras", () => {
  it("re-sends busy prompts for minimax-code only", () => {
    assert.isDefined(acpRegistryAgentFlavorExtras("minimax-code").promptBusyRetry);
    assert.isUndefined(acpRegistryAgentFlavorExtras("claude-acp").promptBusyRetry);
    assert.isUndefined(acpRegistryAgentFlavorExtras("codex").promptBusyRetry);
  });
});
