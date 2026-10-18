import { type ForkLocalListener, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupForkListeners } from "./forkLocalServerGroups";

const project = ProjectId.make("project-1");
const otherProject = ProjectId.make("project-2");

function listener(port: number, folder: ForkLocalListener["folder"]): ForkLocalListener {
  return {
    host: "localhost",
    port,
    url: `http://localhost:${port}`,
    processName: "node",
    pid: port,
    folder,
    check: folder === null ? "unchecked" : "page",
    threadId: null,
  };
}

describe("groupForkListeners", () => {
  it("puts each listener in its highest group: terminal, worktree, project, then others", () => {
    const groups = groupForkListeners({
      shownPorts: new Set([5000]),
      listeners: [
        // Also in the upstream list, so it stays in the terminal group only.
        listener(5000, { projectId: project, folder: "/repo/feature" }),
        listener(5001, { projectId: project, folder: "/repo/feature" }),
        listener(5002, { projectId: project, folder: "/repo/main" }),
        listener(5003, { projectId: otherProject, folder: "/repo/feature" }),
        listener(5004, null),
      ],
      folder: "/repo/feature",
      projectId: project,
    });

    expect({
      worktree: groups.worktree.map((entry) => entry.port),
      project: groups.project.map((entry) => entry.port),
      other: groups.other.map((entry) => entry.port),
    }).toEqual({ worktree: [5001], project: [5002], other: [5003, 5004] });
  });
});
