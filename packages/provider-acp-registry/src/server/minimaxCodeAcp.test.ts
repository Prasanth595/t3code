import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as EffectAcpErrors from "effect-acp/errors";

import { isMinimaxCodeBusyFailure, minimaxCodeFlavorExtras } from "./minimaxCodeAcp.ts";

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

describe("minimaxCodeFlavorExtras", () => {
  it("re-sends busy prompts for the registry agent", () => {
    assert.isDefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "minimax-code",
        isLocal: false,
        commandPath: "",
      }).promptBusyRetry,
    );
  });

  it("re-sends busy prompts for a local install", () => {
    assert.isDefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "/Users/someone/.minimax-code/bin/mcode",
      }).promptBusyRetry,
    );
    assert.isDefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "C:\\tools\\mcode.exe",
      }).promptBusyRetry,
    );
  });

  it("leaves other agents alone", () => {
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "claude-acp",
        isLocal: false,
        commandPath: "",
      }).promptBusyRetry,
    );
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "codex",
        isLocal: false,
        commandPath: "",
      }).promptBusyRetry,
    );
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "/usr/local/bin/mcode-tools",
      }).promptBusyRetry,
    );
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "/usr/local/bin/other-agent",
      }).promptBusyRetry,
    );
  });

  it("does not match the local command of a registry install", () => {
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "codex",
        isLocal: false,
        commandPath: "/usr/local/bin/mcode",
      }).promptBusyRetry,
    );
  });
});
