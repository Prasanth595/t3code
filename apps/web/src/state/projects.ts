import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { serverEnvironment } from "./server";

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
/**
 * Web-only: windows of px0-highlighted lines for the read-only Files surface.
 * Keyed by line window, so scrolling a large file fetches only what is shown.
 */
export const px0File = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:px0:file",
  tag: WS_METHODS.px0File,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});
export const px0Table = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:px0:table",
  tag: WS_METHODS.px0Table,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});
