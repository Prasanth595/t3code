import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/rpc/RpcSchema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("returns observed action state or null without changing the legacy void response", () => {
    const legacy = WsRpcGroup.requests.get(WS_METHODS.pullRequestsRunAction);
    const action = WsRpcGroup.requests.get(WS_METHODS.pullRequestsRunActionWithResult);
    if (legacy === undefined || action === undefined)
      throw new Error("action RPC is not registered");
    expect(legacy.successSchema).toBe(Schema.Void);
    expect(action.payloadSchema).toBe(legacy.payloadSchema);
    expect(action.errorSchema).toBe(legacy.errorSchema);
    const codec = Schema.toCodecJson(action.successSchema);
    const decode = Schema.decodeUnknownSync(codec);
    const result = {
      state: "open",
      isDraft: false,
      updatedAt: "2026-10-27T10:00:00Z",
      mergedAt: null,
      closedAt: null,
      autoMergeEnabled: true,
      observedAt: 1_793_095_200_000,
    };
    for (const value of [
      null,
      result,
      { ...result, headSha: "abc123", autoMergeMethod: "squash" },
      {
        ...result,
        state: "merged",
        mergedAt: result.updatedAt,
        closedAt: result.updatedAt,
        autoMergeEnabled: false,
      },
    ]) {
      expect(decode(Schema.encodeUnknownSync(codec)(value))).toEqual(value);
    }
    expect(decode({ ...result, headSha: null, autoMergeMethod: null })).toEqual(result);
    for (const invalid of [
      { ...result, observedAt: undefined },
      { ...result, observedAt: Infinity },
      { ...result, autoMergeEnabled: undefined },
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
  });

  it("decodes typed refresh events while preserving the legacy numeric stream", () => {
    const legacy = WsRpcGroup.requests.get(WS_METHODS.pullRequestsSubscribeRefreshes);
    const refresh = WsRpcGroup.requests.get(WS_METHODS.pullRequestsSubscribeRefreshEvents);
    if (legacy === undefined || refresh === undefined)
      throw new Error("refresh RPC is not registered");
    if (
      !RpcSchema.isStreamSchema(legacy.successSchema) ||
      !RpcSchema.isStreamSchema(refresh.successSchema)
    ) {
      throw new Error("refresh RPC must stream");
    }
    const decodeLegacy = Schema.decodeSync(legacy.successSchema.success);
    expect(decodeLegacy(7)).toBe(7);
    const codec = Schema.toCodecJson(refresh.successSchema.success);
    const decode = Schema.decodeSync(codec);
    const encode = Schema.encodeUnknownSync(codec);
    const reference = { projectId: "project-1", repository: "pingdotgg/t3code", number: 25761 };
    for (const event of [
      { revision: 0 },
      { revision: 1, reference },
      {
        revision: 2,
        reference,
        result: {
          state: "closed",
          isDraft: true,
          updatedAt: "2026-10-27T10:00:00Z",
          mergedAt: null,
          closedAt: "2026-10-27T10:00:00Z",
          autoMergeEnabled: false,
          observedAt: 1_793_095_200_000,
        },
      },
    ]) {
      expect(decode(encode(event))).toEqual(event);
    }
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
