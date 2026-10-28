import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveThreadCheckpointSummaries } from "./threadCheckpoints.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");
const at = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const rootScopeId = CheckpointScopeId.make("scope-root");
const apiScopeId = CheckpointScopeId.make("scope-api");
const webScopeId = CheckpointScopeId.make("scope-web");

function scope(
  overrides: Partial<OrchestrationV2CheckpointScope> & { readonly id: CheckpointScopeId },
): OrchestrationV2CheckpointScope {
  return {
    threadId,
    runId: null,
    nodeId: NodeId.make("node-root"),
    parentScopeId: rootScopeId,
    providerThreadId: null,
    kind: "repository",
    ordinalWithinParent: 0,
    advancesAppRunCount: false,
    cwd: "/code/app",
    createdAt: at,
    ...overrides,
  };
}

function checkpoint(
  overrides: Partial<OrchestrationV2Checkpoint> & { readonly scopeId: CheckpointScopeId },
): OrchestrationV2Checkpoint {
  return {
    id: CheckpointId.make(`checkpoint-${overrides.scopeId}-${overrides.ordinalWithinScope ?? 1}`),
    threadId,
    runId,
    nodeId: NodeId.make("node-root"),
    parentCheckpointId: null,
    ordinalWithinScope: 1,
    appRunOrdinal: null,
    ref: CheckpointRef.make(`refs/t3/${overrides.scopeId}`),
    status: "ready",
    files: [],
    capturedAt: at,
    ...overrides,
  };
}

const message: OrchestrationV2ConversationMessage = {
  id: MessageId.make("message-1"),
  threadId,
  runId,
  nodeId: null,
  role: "assistant",
  text: "Done",
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "provider",
  createdAt: at,
  updatedAt: at,
};

const rootCheckpoint = checkpoint({
  scopeId: rootScopeId,
  appRunOrdinal: 1,
  files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
  outsideEdits: [
    { root: "/code/infra", name: "infra", tracked: false, files: ["main.tf"], fileCount: 1 },
  ],
});
const apiFiles = [{ path: "src/server.ts", kind: "modified", additions: 3, deletions: 1 }];
const scopes = [
  scope({ id: rootScopeId, kind: "root_run", parentScopeId: null, cwd: "/code/home" }),
  scope({ id: apiScopeId, label: "api", repositoryPath: "/code/api", cwd: "/tasks/t1/api" }),
  scope({ id: webScopeId, label: "web", repositoryPath: "/code/web", ordinalWithinParent: 1 }),
];

describe("deriveThreadCheckpointSummaries", () => {
  it("attaches the run's repo checkpoints and the root's outside edits", () => {
    const [summary] = deriveThreadCheckpointSummaries({
      messages: [message],
      checkpointScopes: scopes,
      checkpoints: [
        // The repo baseline belongs to no run.
        checkpoint({ scopeId: apiScopeId, runId: null, ordinalWithinScope: 0 }),
        rootCheckpoint,
        checkpoint({ scopeId: apiScopeId, files: apiFiles }),
        checkpoint({ scopeId: webScopeId, status: "error" }),
      ],
    });

    expect(summary?.assistantMessageId).toBe(message.id);
    expect(summary?.files).toBe(rootCheckpoint.files);
    expect(summary?.outsideEdits).toBe(rootCheckpoint.outsideEdits);
    expect(summary?.repositories).toEqual([
      {
        scopeId: apiScopeId,
        name: "api",
        repositoryPath: "/code/api",
        cwd: "/tasks/t1/api",
        status: "ready",
        files: apiFiles,
      },
      {
        scopeId: webScopeId,
        name: "web",
        repositoryPath: "/code/web",
        cwd: "/code/app",
        status: "error",
        files: [],
      },
    ]);
  });

  it("gives single-repo threads no repos and no outside edits", () => {
    const [summary] = deriveThreadCheckpointSummaries({
      messages: [message],
      checkpoints: [checkpoint({ scopeId: rootScopeId, appRunOrdinal: 1 })],
    });

    expect(summary?.repositories).toEqual([]);
    expect(summary?.outsideEdits).toEqual([]);
  });

  it("reuses summaries while only streamed messages change", () => {
    const checkpoints = [rootCheckpoint, checkpoint({ scopeId: apiScopeId, files: apiFiles })];
    const [first] = deriveThreadCheckpointSummaries({
      messages: [message],
      checkpointScopes: scopes,
      checkpoints,
    });
    const [second] = deriveThreadCheckpointSummaries({
      messages: [message, { ...message, id: MessageId.make("message-0"), runId: null }],
      checkpointScopes: scopes,
      checkpoints,
    });
    const [moved] = deriveThreadCheckpointSummaries({
      messages: [message, { ...message, id: MessageId.make("message-2") }],
      checkpointScopes: scopes,
      checkpoints,
    });

    expect(second).toBe(first);
    expect(moved).not.toBe(first);
    expect(moved?.assistantMessageId).toBe(MessageId.make("message-2"));
    expect(moved?.repositories).toBe(first?.repositories);
  });
});
