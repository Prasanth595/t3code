// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off tryCatchInEffectGen:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

export interface AntigravityLanguageServerEndpoint {
  readonly port: number;
  readonly csrfToken: string;
}

let cachedEndpoint: { endpoint: AntigravityLanguageServerEndpoint; expiresAt: number } | null =
  null;

function probePort(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const http = require("node:http");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/exa.language_server_pb.LanguageServerService/ListProjects",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "x-codeium-csrf-token": token,
          },
          timeout: 1000,
        },
        (res: { statusCode?: number }) => {
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.write("{}");
      req.end();
    } catch {
      resolve(false);
    }
  });
}

/** Discovers a running Google Antigravity LanguageServerService instance. */
export const findRunningLanguageServer = Effect.fn(
  "AntigravityLanguageServer.findRunningLanguageServer",
)(function* () {
  const now = Date.now();
  if (cachedEndpoint && cachedEndpoint.expiresAt > now) {
    return cachedEndpoint.endpoint;
  }

  try {
    const platform = yield* HostProcess.Platform;
    if (platform === "win32") {
      return null;
    }

    const psOutput = NodeChildProcess.execSync("ps -A -o pid,command", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });

    for (const line of psOutput.split("\n")) {
      if (
        line.includes("language_server") &&
        line.includes("--csrf_token") &&
        !line.includes("grep") &&
        !line.includes("node -e")
      ) {
        const tokenMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/);
        if (!tokenMatch) continue;
        const csrfToken = tokenMatch[1];
        const pid = line.trim().split(/\s+/)[0];
        if (!pid || !/^\d+$/.test(pid)) continue;

        try {
          const lsofOutput = NodeChildProcess.execSync(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
          });
          const portMatches = [...lsofOutput.matchAll(/:(\d+)\s+\(LISTEN\)/g)];
          for (const match of portMatches) {
            const port = parseInt(match[1], 10);
            const verified = yield* Effect.promise(() => probePort(port, csrfToken));
            if (verified) {
              const endpoint: AntigravityLanguageServerEndpoint = { port, csrfToken };
              cachedEndpoint = { endpoint, expiresAt: now + 15_000 };
              return endpoint;
            }
          }
        } catch {
          // Process might have exited or lsof returned no sockets
        }
      }
    }
  } catch {
    // Process discovery failed (sandboxed or restricted permissions)
  }

  return null;
});

/** Invokes an RPC method on the Antigravity LanguageServer. */
export const callLanguageServerRpc = Effect.fn("AntigravityLanguageServer.callLanguageServerRpc")(
  function* (method: string, body: unknown) {
    const endpoint = yield* findRunningLanguageServer();
    if (!endpoint) {
      return null;
    }

    return yield* Effect.promise<unknown>(
      () =>
        new Promise((resolve) => {
          try {
            const http = require("node:http");
            const postData = JSON.stringify(body ?? {});
            const req = http.request(
              {
                hostname: "127.0.0.1",
                port: endpoint.port,
                path: `/exa.language_server_pb.LanguageServerService/${method}`,
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Connect-Protocol-Version": "1",
                  "x-codeium-csrf-token": endpoint.csrfToken,
                  "Content-Length": Buffer.byteLength(postData),
                },
                timeout: 5000,
              },
              (res: {
                statusCode?: number;
                on: (event: string, fn: (arg?: any) => void) => void;
              }) => {
                let data = "";
                res.on("data", (chunk: Buffer | string) => {
                  data += chunk;
                });
                res.on("end", () => {
                  if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                      resolve(data ? JSON.parse(data) : {});
                    } catch {
                      resolve({});
                    }
                  } else {
                    resolve(null);
                  }
                });
              },
            );

            req.on("error", () => {
              cachedEndpoint = null;
              resolve(null);
            });
            req.on("timeout", () => {
              req.destroy();
              cachedEndpoint = null;
              resolve(null);
            });

            req.write(postData);
            req.end();
          } catch {
            resolve(null);
          }
        }),
    );
  },
);

function resolveGeminiHome(userHome?: string): string {
  const base = userHome || process.env.HOME || NodeOS.homedir();
  return NodePath.join(base, ".gemini");
}

function openSummariesDb(userHome?: string) {
  try {
    const geminiHome = resolveGeminiHome(userHome);
    const dbPath = NodePath.join(geminiHome, "antigravity", "conversation_summaries.db");
    if (!NodeFS.existsSync(dbPath)) return null;
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath);
  } catch {
    return null;
  }
}

/**
 * Deletes a cascade trajectory via LanguageServer RPC and purges all traces from
 * SQLite conversation_summaries.db and conversation files on disk.
 */
export const deleteCascadeTrajectory = Effect.fn(
  "AntigravityLanguageServer.deleteCascadeTrajectory",
)(function* (cascadeId: string, options?: { userHome?: string; profileDirectory?: string }) {
  if (!cascadeId) return;

  // 1. LanguageServer RPC
  yield* callLanguageServerRpc("DeleteCascadeTrajectory", { cascadeId });

  // 2. Direct SQLite cleanup in conversation_summaries.db
  try {
    const db = openSummariesDb(options?.userHome);
    if (db) {
      try {
        db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(cascadeId);
        try {
          db.prepare("DELETE FROM conversations_fts WHERE conversation_id = ?").run(cascadeId);
        } catch {}
      } finally {
        db.close();
      }
    }
  } catch {}

  // 3. Remove files from ~/.gemini/antigravity and profileDirectory
  const geminiHome = resolveGeminiHome(options?.userHome);
  const targets = [
    NodePath.join(geminiHome, "antigravity"),
    ...(options?.profileDirectory
      ? [
          NodePath.join(options.profileDirectory, "antigravity-acp"),
          NodePath.join(options.profileDirectory, "antigravity"),
        ]
      : []),
  ];

  for (const targetDir of targets) {
    const convDir = NodePath.join(targetDir, "conversations");
    const base = NodePath.join(convDir, cascadeId);
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      try {
        NodeFS.rmSync(`${base}${suffix}`, { force: true });
      } catch {}
    }
    try {
      NodeFS.rmSync(NodePath.join(targetDir, "brain", cascadeId), { recursive: true, force: true });
    } catch {}
  }
});

/** Cancels a cascade invocation cleanly using CancelCascadeInvocation and CancelCascadeSteps. */
export const cancelCascade = Effect.fn("AntigravityLanguageServer.cancelCascade")(function* (
  cascadeId: string,
) {
  if (!cascadeId) return;
  yield* callLanguageServerRpc("CancelCascadeInvocation", { cascadeId });
  yield* callLanguageServerRpc("CancelCascadeSteps", { cascadeId });
});

/** Resolves an existing Antigravity project matching folderPath, or creates a new one. */
export const resolveOrCreateProjectForWorkspace = Effect.fn(
  "AntigravityLanguageServer.resolveOrCreateProjectForWorkspace",
)(function* (folderPath: string, userHome?: string) {
  const normalizedPath = NodePath.resolve(folderPath);
  const folderUri = `file://${normalizedPath}`;
  const geminiHome = resolveGeminiHome(userHome);
  const projectsDir = NodePath.join(geminiHome, "config", "projects");

  try {
    if (NodeFS.existsSync(projectsDir)) {
      const files = NodeFS.readdirSync(projectsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = JSON.parse(NodeFS.readFileSync(NodePath.join(projectsDir, file), "utf8"));
          const resources = content?.projectResources?.resources ?? [];
          for (const res of resources) {
            if (res?.folderUri === folderUri) {
              return content.id as string;
            }
          }
        } catch {}
      }
    }
  } catch {}

  const projectId = NodeCrypto.randomUUID();
  const projectName = NodePath.basename(normalizedPath) || "project";
  const projectPayload = {
    id: projectId,
    name: projectName,
    projectResources: {
      resources: [{ folderUri }],
    },
  };

  yield* callLanguageServerRpc("CreateProject", { project: projectPayload });

  try {
    NodeFS.mkdirSync(projectsDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(projectsDir, `${projectId}.json`),
      JSON.stringify(projectPayload, null, 2),
      "utf8",
    );
  } catch {}

  return projectId;
});

/** Associates an Antigravity conversation with a specific project ID. */
export const associateConversationProject = Effect.fn(
  "AntigravityLanguageServer.associateConversationProject",
)(function* (cascadeId: string, projectId: string, userHome?: string) {
  if (!cascadeId || !projectId) return;

  yield* Effect.void;
  try {
    const db = openSummariesDb(userHome);
    if (db) {
      try {
        db.prepare(
          "UPDATE conversation_summaries SET project_id = ? WHERE conversation_id = ?",
        ).run(projectId, cascadeId);
      } finally {
        db.close();
      }
    }
  } catch {}
});

/** Syncs a conversation title to LanguageServer and conversation_summaries.db. */
export const syncConversationTitle = Effect.fn("AntigravityLanguageServer.syncConversationTitle")(
  function* (cascadeId: string, title: string, cwd?: string, userHome?: string) {
    if (!cascadeId || !title.trim()) return;
    const cleanTitle = title.trim();

    // 1. LanguageServer annotations
    yield* callLanguageServerRpc("UpdateConversationAnnotations", {
      cascadeId,
      annotations: { title: cleanTitle },
      mergeAnnotations: true,
    });

    // 2. Direct SQLite update
    try {
      const db = openSummariesDb(userHome);
      if (db) {
        try {
          db.prepare("UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?").run(
            cleanTitle,
            cascadeId,
          );
          try {
            db.prepare("UPDATE conversations_fts SET title = ? WHERE conversation_id = ?").run(
              cleanTitle,
              cascadeId,
            );
          } catch {}
        } finally {
          db.close();
        }
      }
    } catch {}

    // 3. Update sidecar .meta file if present
    try {
      const geminiHome = resolveGeminiHome(userHome);
      const metaPath = NodePath.join(
        geminiHome,
        "antigravity",
        "conversations",
        `${cascadeId}.meta`,
      );
      if (NodeFS.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(NodeFS.readFileSync(metaPath, "utf8"));
          meta.title = cleanTitle;
          if (cwd) meta.cwd = cwd;
          NodeFS.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
        } catch {}
      }
    } catch {}
  },
);
