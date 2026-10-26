import { assert, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WsRpcGroup } from "./rpc.ts";
import {
  ClaudeSessionAdoptInput,
  ClaudeSessionRefreshInput,
  ClaudeSessionReleaseInput,
  ClaudeSessionStatusInput,
  ClaudeSessionResult,
  CLAUDE_SESSION_METHODS,
} from "./claudeSessions.ts";

const scope = {
  contractVersion: 1,
  environmentId: "environment-fixture",
  projectId: "project-fixture",
  threadId: "10000000-0000-4000-8000-000000000001",
};
const operationId = "10000000-0000-4000-8000-000000000003";
const physical = { device: "8", inode: "100" };
const process = { pid: 424242, start: "123456", boot: operationId };
const terminal = {
  boot: operationId,
  socket: physical,
  workspaceId: "workspace-fixture",
  tabId: "tab-fixture",
  paneId: "pane-fixture",
  terminalId: "terminal-fixture",
  pty: physical,
  shell: process,
};
const adopt = {
  ...scope,
  operationId,
  expectedEpoch: null,
  providerInstanceId: "claude-fixture",
  nativeId: operationId,
  selection: {
    profile: "manual-selected-v1",
    model: "claude-sonnet-4-6",
    runtimeMode: "approval-required",
  },
  sourceStopped: { kind: "operator-stopped", terminal, knownPreviousProcess: null },
};

describe("manual Claude session contract", () => {
  it("registers exactly wrapped Effect RPC payloads for the four operations", () => {
    const rpc = WsRpcGroup.requests.get(CLAUDE_SESSION_METHODS.adopt);
    assert.isDefined(rpc);
    if (rpc === undefined) throw new Error("Claude adopt RPC missing.");
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
    expect(decode({ input: adopt })).toEqual({ input: adopt });
    assert.throws(() => decode(adopt));
    assert.throws(() => decode({ input: adopt, arbitraryPath: "/other" }));
    for (const tag of Object.values(CLAUDE_SESSION_METHODS))
      assert.isTrue(WsRpcGroup.requests.has(tag));
  });
  it("accepts the four bounded requests without filesystem selectors", () => {
    expect(Schema.decodeUnknownSync(ClaudeSessionAdoptInput)(adopt)).toEqual(adopt);
    const refresh = { ...scope, operationId, expectedEpoch: 1 };
    assert.deepEqual(Schema.decodeUnknownSync(ClaudeSessionRefreshInput)(refresh), refresh);
    const release = { ...refresh, planDigest: "a".repeat(64), destination: terminal };
    assert.deepEqual(Schema.decodeUnknownSync(ClaudeSessionReleaseInput)(release), release);
    assert.deepEqual(Schema.decodeUnknownSync(ClaudeSessionStatusInput)(scope), scope);
  });

  it("rejects unknown keys and invalid nested identities with default decoder options", () => {
    const decode = Schema.decodeUnknownSync(ClaudeSessionAdoptInput);
    for (const input of [
      { ...adopt, home: "/other" },
      { ...adopt, threadId: "thread-alias" },
      { ...adopt, expectedEpoch: 0 },
      { ...adopt, nativeId: operationId.toUpperCase().replace("10000000", "ABCDEF00") },
      { ...adopt, selection: { ...adopt.selection, effort: null } },
      { ...adopt, selection: { ...adopt.selection, extraArgs: [] } },
      {
        ...adopt,
        sourceStopped: {
          ...adopt.sourceStopped,
          terminal: { ...terminal, shell: { ...process, start: "unknown" } },
        },
      },
    ])
      assert.throws(() => decode(input));
  });

  it("keeps missing enrollment distinct from unavailable native history", () => {
    const missing = {
      ...scope,
      provider: "claude",
      operationId: null,
      state: "not-found",
      view: null,
      reservation: null,
      blockers: [],
    };
    expect(Schema.decodeUnknownSync(ClaudeSessionResult)(missing)).toEqual(missing);
    assert.throws(() =>
      Schema.decodeUnknownSync(ClaudeSessionResult)({ ...missing, nativeId: operationId }),
    );
  });

  it("rejects invalid UUID versions and variants in every request identity", () => {
    const decode = Schema.decodeUnknownSync(ClaudeSessionAdoptInput);
    for (const uuid of [
      "11111111-1111-0111-8111-111111111111",
      "11111111-1111-4111-0111-111111111111",
    ]) {
      assert.throws(() => decode({ ...adopt, nativeId: uuid }));
      assert.throws(() => decode({ ...adopt, operationId: uuid }));
      assert.throws(() => decode({ ...adopt, threadId: uuid }));
      assert.throws(() =>
        decode({
          ...adopt,
          sourceStopped: {
            ...adopt.sourceStopped,
            terminal: { ...terminal, boot: uuid },
          },
        }),
      );
    }
  });

  it("preserves lowercase RFC UUID versions, nil and max consistently", () => {
    const decode = Schema.decodeUnknownSync(ClaudeSessionAdoptInput);
    for (const uuid of [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((version) => `11111111-1111-${version}111-8111-111111111111`),
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ]) {
      assert.equal(decode({ ...adopt, nativeId: uuid }).nativeId, uuid);
      assert.equal(decode({ ...adopt, threadId: uuid }).threadId, uuid);
    }
  });
});
