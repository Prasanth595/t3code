import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("remote");
const state = vi.hoisted(() => ({
  settings: undefined as unknown as Atom.Writable<ServerSettings | null>,
  persist: vi.fn(),
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => state.settings,
    updateSettings: Symbol("updateSettings"),
  },
  primaryServerSettingsAtom: undefined,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => ({
        favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }],
      }),
    },
  }),
}));

import { useEnvironmentModelPreferences } from "./useSettings";

function ModelPicker() {
  useEnvironmentModelPreferences(environmentId);
  return null;
}

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  // A server that predates the migration never reports favorites.
  state.settings = Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS);
  state.persist.mockReset().mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

it("migrates once when the server drops the migration and keeps pushing settings", async () => {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <ModelPicker />
      </RegistryContext.Provider>,
    );
  });
  for (let push = 0; push < 3; push += 1) {
    await act(async () => registry.set(state.settings, { ...DEFAULT_SERVER_SETTINGS }));
  }
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
