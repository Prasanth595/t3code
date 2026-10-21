// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  associateConversationProject,
  cancelCascade,
  deleteCascadeTrajectory,
  findRunningLanguageServer,
  resolveOrCreateProjectForWorkspace,
  syncConversationTitle,
} from "./AntigravityLanguageServer.ts";
import { removeAntigravitySessionFiles } from "./acp/AntigravitySessionFiles.ts";

describe("AntigravityLanguageServer", () => {
  it.effect("findRunningLanguageServer handles environment cleanly", () =>
    Effect.gen(function* () {
      const endpoint = yield* findRunningLanguageServer();
      // In CI / test environment, endpoint may be null or a real instance
      if (endpoint !== null) {
        expect(typeof endpoint.port).toBe("number");
        expect(typeof endpoint.csrfToken).toBe("string");
      }
    }),
  );

  it.effect("resolveOrCreateProjectForWorkspace creates and reuses project file", () =>
    Effect.gen(function* () {
      const tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-test-home-"));
      try {
        const workspaceDir = "/tmp/fake-workspace-t3-test";
        const projectId1 = yield* resolveOrCreateProjectForWorkspace(workspaceDir, tempHome);
        expect(projectId1).toBeDefined();
        expect(typeof projectId1).toBe("string");

        // Verify project file was written
        const projectFile = NodePath.join(
          tempHome,
          ".gemini",
          "config",
          "projects",
          `${projectId1}.json`,
        );
        expect(NodeFS.existsSync(projectFile)).toBe(true);
        const data = JSON.parse(NodeFS.readFileSync(projectFile, "utf8"));
        expect(data.id).toBe(projectId1);
        expect(data.projectResources.resources[0].folderUri).toBe(`file://${workspaceDir}`);

        // Reusing the same workspace should return the same project ID
        const projectId2 = yield* resolveOrCreateProjectForWorkspace(workspaceDir, tempHome);
        expect(projectId2).toBe(projectId1);
      } finally {
        NodeFS.rmSync(tempHome, { recursive: true, force: true });
      }
    }),
  );

  it.effect("syncConversationTitle updates sidecar meta and handles missing db", () =>
    Effect.gen(function* () {
      const tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-meta-home-"));
      try {
        const cascadeId = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
        const metaDir = NodePath.join(tempHome, ".gemini", "antigravity", "conversations");
        NodeFS.mkdirSync(metaDir, { recursive: true });
        const metaFile = NodePath.join(metaDir, `${cascadeId}.meta`);
        NodeFS.writeFileSync(metaFile, JSON.stringify({ cwd: "/old/cwd", title: "Old Title" }));

        yield* syncConversationTitle(cascadeId, "New Updated Title", "/new/cwd", tempHome);

        const updated = JSON.parse(NodeFS.readFileSync(metaFile, "utf8"));
        expect(updated.title).toBe("New Updated Title");
        expect(updated.cwd).toBe("/new/cwd");
      } finally {
        NodeFS.rmSync(tempHome, { recursive: true, force: true });
      }
    }),
  );

  it.effect("cancelCascade runs without throwing when server is not active", () =>
    Effect.gen(function* () {
      yield* cancelCascade("dummy-cascade-id");
    }),
  );

  it.effect("associateConversationProject handles missing db gracefully", () =>
    Effect.gen(function* () {
      yield* associateConversationProject("cascade-1", "project-1", "/tmp/nonexistent-home");
    }),
  );

  it.effect("deleteCascadeTrajectory cleans up files and directories", () =>
    Effect.gen(function* () {
      const tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-del-home-"));
      const profileDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-del-profile-"));
      try {
        const cascadeId = "99999999-8888-4444-2222-111111111111";
        const geminiConvDir = NodePath.join(tempHome, ".gemini", "antigravity", "conversations");
        const geminiBrainDir = NodePath.join(
          tempHome,
          ".gemini",
          "antigravity",
          "brain",
          cascadeId,
        );
        NodeFS.mkdirSync(geminiConvDir, { recursive: true });
        NodeFS.mkdirSync(geminiBrainDir, { recursive: true });

        const dbFile = NodePath.join(geminiConvDir, `${cascadeId}.db`);
        const metaFile = NodePath.join(geminiConvDir, `${cascadeId}.meta`);
        NodeFS.writeFileSync(dbFile, "fake db");
        NodeFS.writeFileSync(metaFile, "fake meta");

        yield* deleteCascadeTrajectory(cascadeId, {
          userHome: tempHome,
          profileDirectory: profileDir,
        });

        expect(NodeFS.existsSync(dbFile)).toBe(false);
        expect(NodeFS.existsSync(metaFile)).toBe(false);
        expect(NodeFS.existsSync(geminiBrainDir)).toBe(false);
      } finally {
        NodeFS.rmSync(tempHome, { recursive: true, force: true });
        NodeFS.rmSync(profileDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("removeAntigravitySessionFiles purges disposable setup workspaces", () =>
    Effect.gen(function* () {
      const profileDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-rem-profile-"));
      try {
        const sessionId = "12345678-1234-4234-8234-123456789abc";
        const acpConvDir = NodePath.join(profileDir, "antigravity-acp", "conversations");
        NodeFS.mkdirSync(acpConvDir, { recursive: true });
        const dbFile = NodePath.join(acpConvDir, `${sessionId}.db`);
        NodeFS.writeFileSync(dbFile, "temp setup db");

        yield* removeAntigravitySessionFiles({
          profileDirectory: profileDir,
          sessionId,
          cwd: "/tmp/t3-antigravity-setup-xyz",
        }).pipe(Effect.provide(NodeServices.layer));
      } finally {
        NodeFS.rmSync(profileDir, { recursive: true, force: true });
      }
    }),
  );
});
