import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type ResourceTelemetryHistory,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const monitor = vi.hoisted(() => ({
  telemetry: null as Atom.Atom<
    AsyncResult.AsyncResult<ResourceTelemetrySnapshot, MonitorError>
  > | null,
  history: null as Atom.Atom<
    AsyncResult.AsyncResult<ResourceTelemetryHistory, MonitorError>
  > | null,
  retry: vi.fn(),
}));

vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section aria-label={title}>
      {headerAction}
      {children}
    </section>
  ),
}));

vi.mock("../state/environments", () => ({ usePrimaryEnvironment: () => null }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    resourceTelemetry: () => monitor.telemetry,
    resourceTelemetryHistory: () => monitor.history,
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => monitor.retry }));

import { ResourceTelemetryDiagnostics } from "../components/settings/ResourceTelemetryDiagnostics";

class MonitorError extends Data.TaggedError("MonitorError")<{ readonly message: string }> {}

const environmentId = EnvironmentId.make("remote");
const startError = "The resource monitor is not available.";
const historyError = "Resource history could not start.";

function setup({ retryFails = false } = {}) {
  const readAt = DateTime.makeUnsafe(0);
  const aggregate = {
    processCount: 0,
    currentCpuPercent: 0,
    cpuTimeMs: 0,
    currentRssBytes: 0,
    peakRssBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    processStarts: 0,
    processExits: 0,
  };
  const source = {
    status: "healthy" as const,
    lastSampleAt: Option.some(readAt),
    lastError: Option.none<string>(),
  };
  const snapshot: ResourceTelemetrySnapshot = {
    readAt,
    sampleIntervalMs: 1000,
    processes: [],
    groups: { backend: aggregate, electron: aggregate, monitor: aggregate, allT3: aggregate },
    power: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: false,
      updatedAt: readAt,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt, entries: [] },
    health: {
      native: source,
      desktop: source,
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 1,
      collectionDurationMicros: 0,
      scannedProcessCount: 0,
      retainedProcessCount: 0,
      inaccessibleProcessCount: 0,
    },
  };
  const history: ResourceTelemetryHistory = {
    readAt,
    windowMs: 900000,
    bucketMs: 30000,
    sampleIntervalMs: 1000,
    retainedSampleCount: 0,
    buckets: [],
    topProcesses: [],
    health: snapshot.health,
  };
  let running = false;
  monitor.telemetry = Atom.make(
    Effect.suspend(() =>
      running ? Effect.succeed(snapshot) : Effect.fail(new MonitorError({ message: startError })),
    ),
  );
  monitor.history = Atom.make(
    Effect.suspend(() =>
      running ? Effect.succeed(history) : Effect.fail(new MonitorError({ message: historyError })),
    ),
  );
  monitor.retry.mockReset();
  monitor.retry.mockImplementation(async () => {
    if (retryFails)
      return AsyncResult.failure(Cause.fail(new MonitorError({ message: "Restart failed." })));
    running = true;
    return AsyncResult.success({ accepted: true, snapshot });
  });
  const registry = AtomRegistry.make();
  return {
    registry,
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("resource monitor retry", () => {
  it("clears the settings and history errors after a successful retry without remounting", async () => {
    using fixture = setup();
    await using screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <ResourceTelemetryDiagnostics environmentId={environmentId} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(startError, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();

    await screen.getByRole("button", { name: "Retry monitor" }).click();

    await expect.element(screen.getByText(startError, { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText(historyError, { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Native healthy", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Retry monitor" }))
      .not.toBeInTheDocument();
  });

  it("keeps the failed monitor and history errors visible when retry fails", async () => {
    using fixture = setup({ retryFails: true });
    await using screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <ResourceTelemetryDiagnostics environmentId={environmentId} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(startError, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();

    await screen.getByRole("button", { name: "Retry monitor" }).click();

    await expect.element(screen.getByRole("button", { name: "Retry monitor" })).toBeEnabled();
    expect(monitor.retry).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
    await expect.element(screen.getByText(startError, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();
  });
});
