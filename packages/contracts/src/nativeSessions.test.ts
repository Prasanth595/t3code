import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  NativeSessionController,
  NativeSessionSettings,
  NativeSessionAdoptInput,
} from "./nativeSessions.ts";

it("requires a tagged controller with a nonnegative epoch", () => {
  expect(Schema.is(NativeSessionController)({ type: "t3", epoch: 1 })).toBe(true);
  expect(Schema.is(NativeSessionController)({ type: "t3", epoch: -1 })).toBe(false);
  expect(Schema.is(NativeSessionController)({ epoch: 1 })).toBe(false);
});
it("retains the complete supported permission policy and rejects unknown policy fields", () => {
  const settings = {
    model: "gpt-5.4",
    reasoningEffort: "xhigh",
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/private/project"],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    },
  };
  expect(
    Schema.decodeUnknownSync(NativeSessionSettings, { onExcessProperty: "error" })(settings),
  ).toEqual(settings);
  expect(() =>
    Schema.decodeUnknownSync(NativeSessionSettings, { onExcessProperty: "error" })({
      ...settings,
      sandboxPolicy: { ...settings.sandboxPolicy, permissions: "custom" },
    }),
  ).toThrow();
});
it("rejects adoption without exact operation and source exit evidence", () => {
  expect(
    Schema.is(NativeSessionAdoptInput)({
      contractVersion: 1,
      threadId: "thread",
      binding: { nativeId: "native" },
    }),
  ).toBe(false);
});
