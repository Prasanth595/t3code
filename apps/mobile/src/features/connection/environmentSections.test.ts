import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionRoute,
  entryWithRoutes,
  presentEnvironmentConnection,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { projectEnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { splitEnvironmentSections } from "./environmentSections";

function connectedEnvironment(
  input: Omit<Partial<ConnectedEnvironmentSummary>, "environmentId"> & {
    readonly environmentId: string;
    readonly isRelayManaged: boolean;
  },
): ConnectedEnvironmentSummary {
  return {
    environmentId: EnvironmentId.make(input.environmentId),
    environmentLabel: input.environmentLabel ?? input.environmentId,
    displayUrl: input.displayUrl ?? `https://${input.environmentId}.example.test/`,
    isRelayManaged: input.isRelayManaged,
    hasRelayRoute: input.hasRelayRoute ?? input.isRelayManaged,
    isEnabled: input.isEnabled ?? true,
    connectionState: input.connectionState ?? "connected",
    connectionError: input.connectionError ?? null,
    connectionErrorTraceId: input.connectionErrorTraceId ?? null,
  };
}

function cloudEnvironment(environmentId: string): RelayClientEnvironmentRecord {
  return {
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    endpoint: {
      httpBaseUrl: `https://${environmentId}.cloud.example.test/`,
      wsBaseUrl: `wss://${environmentId}.cloud.example.test/ws`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-01-01T00:00:00.000Z",
  };
}

function savedEnvironment(
  environmentId: string,
  options: { readonly learnedLan: boolean; readonly relayFirst?: boolean },
): ConnectedEnvironmentSummary {
  const id = EnvironmentId.make(environmentId);
  const lan: ConnectionRoute = {
    target: new BearerConnectionTarget({
      environmentId: id,
      label: "Mac mini",
      connectionId: "lan",
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: "lan",
        environmentId: id,
        label: "Mac mini",
        httpBaseUrl: "http://192.168.1.106:3773/",
        wsBaseUrl: "ws://192.168.1.106:3773/",
        ...(options.learnedLan ? { learned: true } : {}),
      }),
    ),
  };
  const relay: ConnectionRoute = {
    target: new RelayConnectionTarget({ environmentId: id, label: "Mac mini" }),
    profile: Option.none(),
  };
  const entry = entryWithRoutes(
    { target: relay.target, profile: relay.profile, enabled: true },
    options.relayFirst === true ? [relay, lan] : [lan, relay],
  );
  return projectEnvironmentConnectionSummary(id, {
    entry,
    connection: presentEnvironmentConnection(AVAILABLE_CONNECTION_STATE),
    serverConfig: null,
  });
}

describe("mobile environment settings sections", () => {
  it("keeps a LAN-paired environment local after T3 Connect is added to it", () => {
    const paired = savedEnvironment("environment-mini", { learnedLan: false });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [paired],
      cloudEnvironments: [cloudEnvironment("environment-mini")],
    });

    expect(sections.localEnvironments).toEqual([paired]);
    expect(sections.connectedCloudEnvironments).toEqual([]);
    expect(sections.availableCloudEnvironments).toEqual([]);
  });

  it("shows the paired address when T3 Connect is ordered first", () => {
    const paired = savedEnvironment("environment-mini", { learnedLan: false, relayFirst: true });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [paired],
      cloudEnvironments: null,
    });

    expect(sections.localEnvironments).toEqual([paired]);
    expect(paired.displayUrl).toBe("http://192.168.1.106:3773/");
  });

  it("keeps a T3 Connect environment under T3 Connect after it learns a LAN address", () => {
    const relay = savedEnvironment("environment-mini", { learnedLan: true });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [relay],
      cloudEnvironments: [cloudEnvironment("environment-mini")],
    });

    expect(sections.localEnvironments).toEqual([]);
    expect(sections.connectedCloudEnvironments).toEqual([relay]);
    expect(sections.availableCloudEnvironments).toEqual([]);
  });

  it("keeps saved relay-managed connections under T3 Connect", () => {
    const local = connectedEnvironment({
      environmentId: "environment-local",
      isRelayManaged: false,
    });
    const cloud = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: true,
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [cloud, local],
      cloudEnvironments: [
        cloudEnvironment("environment-cloud"),
        cloudEnvironment("environment-new"),
      ],
    });

    expect(sections.localEnvironments).toEqual([local]);
    expect(sections.connectedCloudEnvironments).toEqual([cloud]);
    expect(
      sections.availableCloudEnvironments.map((environment) => environment.environmentId),
    ).toEqual([EnvironmentId.make("environment-new")]);
  });

  it("keeps saved relay-managed connections visible when cloud listing is unavailable", () => {
    const cloud = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: true,
      connectionState: "reconnecting",
      connectionError: "Environment did not respond before the connection timeout.",
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [cloud],
      cloudEnvironments: null,
    });

    expect(sections.localEnvironments).toEqual([]);
    expect(sections.connectedCloudEnvironments).toEqual([cloud]);
    expect(sections.availableCloudEnvironments).toEqual([]);
  });

  it("still offers a cloud environment saved directly as a local backend", () => {
    const local = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: false,
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [local],
      cloudEnvironments: [cloudEnvironment("environment-cloud")],
    });

    expect(sections.localEnvironments).toEqual([local]);
    expect(sections.connectedCloudEnvironments).toEqual([]);
    expect(
      sections.availableCloudEnvironments.map((environment) => environment.environmentId),
    ).toEqual([EnvironmentId.make("environment-cloud")]);
  });
});
