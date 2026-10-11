import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildVoiceDispatchProjects } from "./voiceDispatchProjects";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

function source(environmentId: EnvironmentId, id: string, title: string, workspaceRoot: string) {
  return { environmentId, id: ProjectId.make(id), title, workspaceRoot };
}

describe("buildVoiceDispatchProjects", () => {
  it("leaves out each environment's Scratch project", () => {
    const projects = buildVoiceDispatchProjects({
      projects: [
        source(laptop, "app", "App", "/code/app"),
        source(laptop, "scratch", "Scratch", "/home/.t3/scratch"),
      ],
      environmentLabels: new Map([[laptop, "Laptop"]]),
      scratchWorkspaceRoots: new Map([[laptop, "/home/.t3/scratch"]]),
    });

    expect(projects.map((project) => project.title)).toEqual(["App"]);
  });

  it("names the environment only when projects come from more than one", () => {
    const single = buildVoiceDispatchProjects({
      projects: [source(laptop, "app", "App", "/code/app")],
      environmentLabels: new Map([[laptop, "Laptop"]]),
      scratchWorkspaceRoots: new Map(),
    });
    const several = buildVoiceDispatchProjects({
      projects: [
        source(laptop, "app", "App", "/code/app"),
        source(server, "api", "API", "/srv/api"),
      ],
      environmentLabels: new Map([
        [laptop, "Laptop"],
        [server, "Build box"],
      ]),
      scratchWorkspaceRoots: new Map(),
    });

    expect(single[0]).toMatchObject({ key: "laptop/app", subtitle: null });
    expect(several.map((project) => project.subtitle)).toEqual(["Laptop", "Build box"]);
  });
});
