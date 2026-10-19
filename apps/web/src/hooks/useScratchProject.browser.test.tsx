import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    connection: { phase: string };
    serverConfig: { scratchWorkspaceRoot: string };
  }>,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("./useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => vi.fn()) as never,
}));
import { useScratchProject } from "./useScratchProject";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const OTHER = EnvironmentId.make("other");

function environment(environmentId: EnvironmentId, phase: string) {
  return {
    environmentId,
    connection: { phase },
    serverConfig: { scratchWorkspaceRoot: `/scratch/${environmentId}` },
  };
}

function Probe({ current }: { current: EnvironmentId }) {
  return <output>{useScratchProject().scratchEnvironmentId(current) ?? "none"}</output>;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function scratchTargetFrom(current: EnvironmentId) {
  await act(async () => root.render(<Probe current={current} />));
  return container.textContent;
}

it("falls back from an unavailable current machine only to a sole connected alternative", async () => {
  state.environments = [environment(REMOTE, "reconnecting"), environment(LOCAL, "connected")];
  expect(await scratchTargetFrom(REMOTE)).toBe(LOCAL);

  state.environments = [environment(REMOTE, "connected"), environment(LOCAL, "connected")];
  expect(await scratchTargetFrom(REMOTE)).toBe(REMOTE);

  state.environments = [
    environment(REMOTE, "reconnecting"),
    environment(LOCAL, "connected"),
    environment(OTHER, "connected"),
  ];
  expect(await scratchTargetFrom(REMOTE)).toBe("none");
});
