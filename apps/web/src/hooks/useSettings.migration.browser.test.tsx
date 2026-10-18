import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const settingsFromServerWithoutMigration = DEFAULT_SERVER_SETTINGS;

const state = vi.hoisted(() => ({
  settings: undefined as unknown as Atom.Writable<ServerSettings | null>,
  connection: undefined as unknown as Atom.Writable<
    AsyncResult.AsyncResult<SupervisorConnectionState>
  >,
  persist: vi.fn(),
}));

vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      stateAtom: (() => state.connection) as never,
    },
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: (() => state.settings) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: (() => ({
    persistence: {
      getClientSettings: async () => ({
        favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }],
      }),
    },
  })) as never,
}));

import { useEnvironmentModelPreferences } from "./useSettings";

function ModelPicker(props: { readonly environmentId: EnvironmentId }) {
  useEnvironmentModelPreferences(props.environmentId);
  return null;
}

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.settings = Atom.make<ServerSettings | null>(settingsFromServerWithoutMigration);
  state.connection = Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(
    AsyncResult.success(connected(1)),
  );
  state.persist
    .mockReset()
    .mockResolvedValue(AsyncResult.success(settingsFromServerWithoutMigration));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

function connected(generation: number): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, desired: true, phase: "connected", generation };
}

async function renderModelPicker(environmentId: EnvironmentId) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ModelPicker environmentId={environmentId} />
      </RegistryContext.Provider>,
    ),
  );
}

async function pushSettings(count: number) {
  for (let push = 0; push < count; push += 1) {
    await act(async () => registry.set(state.settings, { ...settingsFromServerWithoutMigration }));
  }
}

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});

it("migrates once when the server drops the migration and keeps pushing settings", async () => {
  const environmentId = EnvironmentId.make("remote");
  await renderModelPicker(environmentId);
  await pushSettings(3);
  expect(state.persist).toHaveBeenCalledTimes(1);
  expect(state.persist).toHaveBeenCalledWith({
    environmentId,
    input: {
      patch: {
        migrateModelPreferences: {
          favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }],
        },
      },
    },
  });
});

it("migrates again after the environment reconnects", async () => {
  await renderModelPicker(EnvironmentId.make("upgraded"));
  await pushSettings(2);
  await act(async () => registry.set(state.connection, AsyncResult.success(connected(2))));
  await pushSettings(2);
  expect(state.persist).toHaveBeenCalledTimes(2);
});

it("waits for the environment to connect before migrating", async () => {
  registry.set(state.connection, AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  await renderModelPicker(EnvironmentId.make("connecting"));
  await pushSettings(2);
  expect(state.persist).not.toHaveBeenCalled();
  await act(async () => registry.set(state.connection, AsyncResult.success(connected(1))));
  await pushSettings(2);
  expect(state.persist).toHaveBeenCalledTimes(1);
});
