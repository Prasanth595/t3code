// @effect-diagnostics nodeBuiltinImport:off - exercises the launcher against real temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { cacheEnvironment } from "./vp.ts";

it("scopes the cache to opted-in projects and keeps credentials outside the checkout", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "task-cache-env-"));
  try {
    const project = NodePath.join(root, "project");
    const home = NodePath.join(root, "home");
    NodeFS.mkdirSync(NodePath.join(project, "nested"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, ".config/t3-task-cache"), { recursive: true });
    const endpoint = "https://cache.example/projects/t3code";
    NodeFS.writeFileSync(NodePath.join(project, ".task-cache.json"), JSON.stringify({ endpoint }));
    expect(cacheEnvironment(NodePath.join(project, "nested"), {}, home)).toEqual({
      VP_REMOTE_CACHE_URL: endpoint,
      VP_REMOTE_CACHE: "read",
    });
    expect(
      cacheEnvironment(root, {}, home, ["-C", "project", "run", "typecheck"]).VP_REMOTE_CACHE_URL,
    ).toBe(endpoint);
    expect(
      cacheEnvironment(root, {}, home, ["-Cproject", "run", "typecheck"]).VP_REMOTE_CACHE_URL,
    ).toBe(endpoint);
    NodeFS.writeFileSync(
      NodePath.join(home, ".config/t3-task-cache/credentials.json"),
      JSON.stringify({
        [endpoint]: { name: "julius", token: "private-token" },
      }),
    );
    expect(cacheEnvironment(project, {}, home)).toEqual({
      VP_REMOTE_CACHE_URL: "https://julius:private-token@cache.example/projects/t3code",
      VP_REMOTE_CACHE: "read-write",
    });
    expect(cacheEnvironment(project, { VP_REMOTE_CACHE: "off" }, home).VP_REMOTE_CACHE).toBe("off");
    expect(
      cacheEnvironment(project, { VP_REMOTE_CACHE_URL: "https://override.example" }, home)
        .VP_REMOTE_CACHE_URL,
    ).toBe("https://override.example");
    const env = { PATH: "/bin" };
    expect(cacheEnvironment(root, env, home)).toBe(env);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
