// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const resolveCwd = vi.hoisted(() => vi.fn());
vi.mock("./projects", () => ({ projectEnvironment: { resolveCwd } }));

import { useProjectCwd } from "./use-project-cwd";

const cwdQueries = Atom.family((key: string) =>
  Atom.make<AsyncResult.AsyncResult<{ cwd: string }, Error>>(AsyncResult.initial(true)).pipe(
    Atom.withLabel(key),
  ),
);
const firstEnvironment = EnvironmentId.make("environment-1");
const secondEnvironment = EnvironmentId.make("environment-2");
const initialInput = {
  environmentId: firstEnvironment,
  projectCwd: "/repo/ios",
  worktreePath: "/worktrees/feature",
};
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;

function Consumer(props: Parameters<typeof useProjectCwd>[0]) {
  return <>{useProjectCwd(props) ?? "pending"}</>;
}

function render(input: Parameters<typeof useProjectCwd>[0]) {
  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <Consumer {...input} />
      </RegistryContext.Provider>,
    );
  });
}

function settle(
  input: typeof initialInput,
  result: AsyncResult.AsyncResult<{ cwd: string }, Error>,
) {
  act(() => {
    registry.set(
      cwdQueries(
        JSON.stringify({
          environmentId: input.environmentId,
          input: { cwd: input.projectCwd, worktreePath: input.worktreePath },
        }),
      ),
      result,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registry = AtomRegistry.make();
  container = document.createElement("div");
  root = createRoot(container);
  resolveCwd.mockReset();
  resolveCwd.mockImplementation((target: unknown) => cwdQueries(JSON.stringify(target)));
});

afterEach(() => {
  act(() => root.unmount());
  registry.dispose();
});

describe("useProjectCwd", () => {
  it("uses the project directory immediately when no worktree is selected", () => {
    render({ ...initialInput, worktreePath: null });
    expect(container.textContent).toBe("/repo/ios");
    expect(resolveCwd).not.toHaveBeenCalled();
  });

  it("waits for the environment's directory and accepts its root fallback", () => {
    render(initialInput);
    expect(container.textContent).toBe("pending");

    settle(initialInput, AsyncResult.success({ cwd: "/worktrees/feature/ios" }));
    expect(container.textContent).toBe("/worktrees/feature/ios");

    settle(initialInput, AsyncResult.success({ cwd: "/worktrees/feature" }));
    expect(container.textContent).toBe("/worktrees/feature");
  });

  it("does not use a previous environment or worktree while a new query is pending", () => {
    render(initialInput);
    settle(initialInput, AsyncResult.success({ cwd: "/worktrees/feature/ios" }));

    const nextEnvironment = { ...initialInput, environmentId: secondEnvironment };
    render(nextEnvironment);
    expect(container.textContent).toBe("pending");
    settle(nextEnvironment, AsyncResult.success({ cwd: "/worktrees/feature" }));
    expect(container.textContent).toBe("/worktrees/feature");

    render({ ...nextEnvironment, worktreePath: "/worktrees/other" });
    expect(container.textContent).toBe("pending");
    settle(initialInput, AsyncResult.success({ cwd: "/stale-response" }));
    expect(container.textContent).toBe("pending");
  });

  it("does not substitute an unverified path after a resolution failure", () => {
    render(initialInput);
    settle(initialInput, AsyncResult.failure(Cause.fail(new Error("Disconnected"))));
    expect(container.textContent).toBe("pending");

    render({ ...initialInput, worktreePath: null });
    expect(container.textContent).toBe("/repo/ios");
  });
});
