import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type DiscoveredLocalServer, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { placeListeners, resolveProjectFolders } from "./PreviewServerGroups.ts";

const listener = (port: number, pid: number): DiscoveredLocalServer => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}`,
  processName: "node",
  pid,
  terminal: null,
});

it.layer(NodeServices.layer)("PreviewServerGroups", (it) => {
  it.effect(
    "places each listener in its deepest real project folder and checks only shown projects",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-server-groups-" }),
        );
        const mkdir = (relative: string) =>
          fileSystem.makeDirectory(path.join(temp, relative), { recursive: true });
        yield* mkdir("repo/src");
        yield* mkdir("repo/.worktrees/feature/web");
        yield* mkdir("second");
        yield* mkdir("elsewhere");
        // The project root is stored through a symlink, and its worktree is nested inside it.
        yield* fileSystem.symlink(path.join(temp, "repo"), path.join(temp, "link"));
        const shown = ProjectId.make("project-shown");
        const other = ProjectId.make("project-other");
        const rootFolder = path.join(temp, "link");
        const worktreeFolder = path.join(temp, "link/.worktrees/feature");

        const folders = yield* resolveProjectFolders([
          { projectId: shown, folder: rootFolder },
          { projectId: shown, folder: worktreeFolder },
          { projectId: other, folder: path.join(temp, "second") },
          { projectId: other, folder: path.join(temp, "missing") },
        ]);
        const probed: number[] = [];
        const placed = yield* placeListeners({
          listeners: [
            listener(5101, 1),
            listener(5102, 2),
            listener(5103, 3),
            listener(5104, 4),
            { ...listener(5105, 5), pid: null },
          ],
          cwdByPid: new Map([
            [1, path.join(temp, "repo/src")],
            [2, path.join(temp, "repo/.worktrees/feature/web")],
            [3, path.join(temp, "second")],
            [4, path.join(temp, "elsewhere")],
          ]),
          folders,
          checkedProjects: new Set([shown]),
          probe: (server) =>
            Effect.sync(() => {
              probed.push(server.port);
              return server.port === 5101 ? `https://localhost:${server.port}` : null;
            }),
        });

        expect(placed.map(({ port, folder, check }) => ({ port, folder, check }))).toEqual([
          { port: 5101, folder: { projectId: shown, folder: rootFolder }, check: "page" },
          { port: 5102, folder: { projectId: shown, folder: worktreeFolder }, check: "noPage" },
          {
            port: 5103,
            folder: { projectId: other, folder: path.join(temp, "second") },
            check: "unchecked",
          },
          { port: 5104, folder: null, check: "unchecked" },
          { port: 5105, folder: null, check: "unchecked" },
        ]);
        expect(placed[0]?.url).toBe("https://localhost:5101");
        // Upstream crash rule (pingdotgg/t3code#18377): no HTTP to a listener outside the projects.
        expect(probed.toSorted()).toEqual([5101, 5102]);
      }),
  );
});
