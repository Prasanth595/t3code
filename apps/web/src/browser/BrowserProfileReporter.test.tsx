import * as Exit from "effect/Exit";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: ["one"],
  configs: new Map([
    ["one", { environment: { capabilities: { serverBrowser: true } } }],
    ["two", { environment: { capabilities: { serverBrowser: true } } }],
  ]),
  settings: { browserProfiles: [], browserDefaultProfileId: "default" },
  operable: new Set(["one", "two"]),
  report: vi.fn<(input: { environmentId: string }) => Promise<Exit.Exit<void, string>>>(),
}));

vi.mock("~/hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useClientSettings: (select: (settings: typeof state.settings) => unknown) =>
    select(state.settings),
}));
vi.mock("~/state/entities", () => ({ useServerConfigs: () => state.configs }));
vi.mock("~/state/environments", () => ({
  useConnectedEnvironmentIds: () => state.connected,
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("~/state/session", () => ({ useEnvironmentsWithScope: () => state.operable }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { reportProfiles: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.report }));

import { BrowserProfileReporter } from "./BrowserProfileReporter";

let renderer: ReactTestRenderer | undefined;

function pendingReport() {
  let resolve!: (result: Exit.Exit<void, string>) => void;
  const promise = new Promise<Exit.Exit<void, string>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.connected = ["one"];
  state.settings = { browserProfiles: [], browserDefaultProfileId: "default" };
  state.report.mockReset();
  state.report.mockResolvedValue(Exit.fail("offline"));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    renderer = create(<BrowserProfileReporter />);
  });
}

async function refresh() {
  await act(async () => renderer!.update(<BrowserProfileReporter />));
}

async function exhaustRetries() {
  for (const delay of [5_000, 10_000, 15_000]) {
    await act(async () => vi.advanceTimersByTimeAsync(delay));
  }
}

it("keeps an exhausted environment capped when another environment triggers retry sweeps", async () => {
  await mount();
  await exhaustRetries();
  expect(state.report).toHaveBeenCalledTimes(4);

  state.connected = ["one", "two"];
  await refresh();
  await exhaustRetries();
  const callsFor = (id: string) =>
    state.report.mock.calls.filter(([input]) => input.environmentId === id);
  expect(callsFor("one")).toHaveLength(4);
  expect(callsFor("two")).toHaveLength(4);
});

it("gives changed profile settings a fresh retry budget", async () => {
  await mount();
  await exhaustRetries();
  state.settings = { ...state.settings, browserDefaultProfileId: "new-default" };
  await refresh();
  await exhaustRetries();
  expect(state.report).toHaveBeenCalledTimes(8);
});

it("does not schedule retries when a report fails after unmount", async () => {
  const pending = pendingReport();
  state.report.mockReturnValue(pending.promise);
  await mount();
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => pending.resolve(Exit.fail("offline")));
  expect(vi.getTimerCount()).toBe(0);
  expect(state.report).toHaveBeenCalledTimes(1);
});

it("deduplicates successful reports and reports again after reconnect", async () => {
  state.report.mockResolvedValue(Exit.succeed(undefined));
  await mount();
  state.connected = ["one"];
  await refresh();
  expect(state.report).toHaveBeenCalledTimes(1);
  state.connected = [];
  await refresh();
  state.connected = ["one"];
  await refresh();
  expect(state.report).toHaveBeenCalledTimes(2);
});

it("skips disconnected environments even when their server config is cached", async () => {
  state.connected = [];
  await mount();
  await exhaustRetries();
  expect(state.report).not.toHaveBeenCalled();
});

it("does not retry an interruption on a timer or cache it as a successful report", async () => {
  state.report.mockResolvedValueOnce(Exit.interrupt());
  await mount();
  expect(vi.getTimerCount()).toBe(0);
  await exhaustRetries();
  expect(state.report).toHaveBeenCalledTimes(1);
  state.report.mockResolvedValue(Exit.succeed(undefined));
  state.connected = ["one"];
  await refresh();
  expect(state.report).toHaveBeenCalledTimes(2);
});

it("ignores a late completion from the first Strict Mode effect lifecycle", async () => {
  const pending = pendingReport();
  state.report.mockReturnValueOnce(pending.promise);
  await act(async () => {
    renderer = create(
      <StrictMode>
        <BrowserProfileReporter />
      </StrictMode>,
    );
  });
  expect(state.report).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(Exit.succeed(undefined)));
  await exhaustRetries();
  expect(state.report).toHaveBeenCalledTimes(5);
});
