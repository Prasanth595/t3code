import { RegistryContext } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type AuthSessionState,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "disconnected" };
  }[],
  providers: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
  requests: [] as EnvironmentId[],
}));

vi.mock(import("~/state/environments"), () => ({
  useEnvironments: (() => ({ environments: state.environments })) as never,
  useEnvironmentProviders: () => state.providers,
}));
vi.mock(import("~/state/server"), () => ({
  serverEnvironment: { updateProvider: {} } as never,
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: (() => async ({ environmentId }: { environmentId: EnvironmentId }) => {
    state.requests.push(environmentId);
    return AsyncResult.success(undefined);
  }) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { useProviderUpdates } from "./ProviderUpdatesAction";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateCommand: "npm install -g @openai/codex",
    canUpdate: true,
    checkedAt: "2026-10-21T00:00:00.000Z",
    message: "Update available.",
  },
};

function session(scopes: AuthSessionState["scopes"]) {
  return AsyncResult.success<AuthSessionState>({
    authenticated: true,
    scopes,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  });
}

function setup() {
  state.environments = [
    { environmentId: EnvironmentId.make("read-only"), label: "Read only" },
    { environmentId: EnvironmentId.make("writable"), label: "Writable" },
    { environmentId: EnvironmentId.make("unresolved"), label: "Unresolved" },
  ].map((environment) => ({ ...environment, connection: { phase: "connected" } }));
  state.providers = new Map(state.environments.map(({ environmentId }) => [environmentId, [provider]]));
  state.requests = [];
  const sessions = new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<AuthSessionState>>>([
    [state.environments[0]!.environmentId, Atom.make(session(["orchestration:read"]))],
    [state.environments[1]!.environmentId, Atom.make(session([AuthProvidersManageScope]))],
    [
      state.environments[2]!.environmentId,
      Atom.make(AsyncResult.initial<AuthSessionState>()),
    ],
  ]);
  const spy = vi.spyOn(environmentSession, "sessionStateAtom").mockImplementation(
    ((id: EnvironmentId) => sessions.get(id)!) as typeof environmentSession.sessionStateAtom,
  );
  return { sessions, [Symbol.dispose]: () => spy.mockRestore() };
}

it("bulk provider updates exclude connections without a confirmed management grant", async () => {
  using fixture = setup();
  let updates!: ReturnType<typeof useProviderUpdates>;
  function Probe() {
    updates = useProviderUpdates();
    return null;
  }
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Probe />
    </RegistryContext.Provider>,
  );

  const writableId = state.environments[1]!.environmentId;
  expect(updates.machines.map(({ environmentId }) => environmentId)).toEqual([writableId]);
  await act(async () => {
    await updates.updateAll({ quiet: true });
  });
  expect(state.requests).toEqual([writableId]);

  await act(() => {
    appAtomRegistry.set(fixture.sessions.get(writableId)!, session(["orchestration:read"]));
  });
  expect(updates.machines).toEqual([]);
  state.requests = [];
  await act(async () => {
    await updates.updateAll({ quiet: true });
  });
  expect(state.requests).toEqual([]);
});
