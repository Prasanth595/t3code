import { EnvironmentId, type ResourceTelemetrySnapshot } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const environmentId = EnvironmentId.make("remote");

const monitor = vi.hoisted(() => ({
  error: null as string | null,
  retry: vi.fn(),
}));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: (() => ({ environmentId })) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      resourceTelemetry: () => null,
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => monitor.retry) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => {
    const [error, setError] = useState(monitor.error);
    return {
      data: null,
      dataUpdatedAt: 0,
      error,
      failure: null,
      isPending: false,
      isSuccess: error === null,
      refresh: () => setError(monitor.error),
    };
  }) as never,
}));

import { useResourceTelemetry, type ResourceTelemetryState } from "./resourceTelemetryState";

function Probe(props: { onResult: (state: ResourceTelemetryState) => void }) {
  props.onResult(useResourceTelemetry());
  return null;
}

describe("useResourceTelemetry", () => {
  it("clears the stale error once a retry succeeds", async () => {
    monitor.error = "The resource monitor is not available.";
    monitor.retry.mockImplementation(async () => {
      monitor.error = null;
      return AsyncResult.success({ snapshot: {} as ResourceTelemetrySnapshot });
    });
    let state: ResourceTelemetryState | undefined;
    await using _screen = await render(<Probe onResult={(next) => (state = next)} />);
    expect(state!.error).toBe("The resource monitor is not available.");

    await act(async () => {
      await state!.retry();
    });

    expect(state!.error).toBeNull();
  });
});
