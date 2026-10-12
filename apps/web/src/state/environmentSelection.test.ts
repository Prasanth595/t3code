import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createEnvironmentSelectionAtoms } from "./environmentSelection";

const LAPTOP = EnvironmentId.make("laptop");
const SERVER = EnvironmentId.make("server");

function project(id: string, environmentId: EnvironmentId) {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/repos/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    scripts: [],
  } satisfies EnvironmentProject;
}

function makeHarness() {
  const registry = AtomRegistry.make();
  const catalogValueAtom = Atom.make({ isReady: true }).pipe(Atom.keepAlive);
  const environmentsAtom = Atom.make<
    ReadonlyArray<
      Pick<EnvironmentConnectionSummary, "environmentId" | "isEnabled" | "connectionState">
    >
  >([
    { environmentId: LAPTOP, isEnabled: true, connectionState: "connected" },
    { environmentId: SERVER, isEnabled: true, connectionState: "connected" },
  ]).pipe(Atom.keepAlive);
  const projectsAtom = Atom.make<ReadonlyArray<EnvironmentProject>>([
    project("api", LAPTOP),
    project("notes", SERVER),
  ]).pipe(Atom.keepAlive);
  const atoms = createEnvironmentSelectionAtoms({
    catalogValueAtom,
    environmentsAtom,
    projectsAtom,
  });
  return { registry, environmentsAtom, projectsAtom, atoms };
}

describe("environment selection atoms", () => {
  it("narrows projects to the selected environment, and shows all of them otherwise", () => {
    const { registry, projectsAtom, atoms } = makeHarness();
    expect(registry.get(atoms.projectsAtom(SERVER)).map((entry) => entry.id)).toEqual(["notes"]);
    expect(registry.get(atoms.projectsAtom(null))).toBe(registry.get(projectsAtom));
  });

  it("shares one result across readers and keeps it through unrelated catalog changes", () => {
    const { registry, environmentsAtom, atoms } = makeHarness();
    const unmountResolved = registry.mount(atoms.resolvedAtom(SERVER));
    const unmountProjects = registry.mount(atoms.projectsAtom(SERVER));
    const resolved = registry.get(atoms.resolvedAtom(SERVER));
    const projects = registry.get(atoms.projectsAtom(SERVER));
    expect(registry.get(atoms.resolvedAtom(SERVER))).toBe(resolved);
    expect(registry.get(atoms.projectsAtom(SERVER))).toBe(projects);

    // Another environment reconnecting does not change this selection.
    registry.set(environmentsAtom, [
      { environmentId: LAPTOP, isEnabled: true, connectionState: "connecting" },
      { environmentId: SERVER, isEnabled: true, connectionState: "connected" },
    ]);
    expect(registry.get(atoms.resolvedAtom(SERVER))).toBe(resolved);
    expect(registry.get(atoms.projectsAtom(SERVER))).toBe(projects);

    // The selected environment going offline does.
    registry.set(environmentsAtom, [
      { environmentId: LAPTOP, isEnabled: true, connectionState: "connected" },
      { environmentId: SERVER, isEnabled: true, connectionState: "offline" },
    ]);
    expect(registry.get(atoms.resolvedAtom(SERVER))).toEqual({
      status: "active",
      environmentId: SERVER,
      online: false,
    });
    expect(registry.get(atoms.projectsAtom(SERVER))).toBe(projects);
    unmountResolved();
    unmountProjects();
  });
});
