/**
 * Fork RPCs. `rpc.ts` spreads `FORK_WS_METHODS` into `WS_METHODS` and merges `ForkWsRpcGroup`
 * into `WsRpcGroup` before the scope middleware, so the upstream file keeps two hook lines.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  ForkChangelogError,
  ForkReleaseChanges,
  ForkReleaseChangesInput,
  ForkReleaseList,
  ForkSyncStatus,
  ForkUpstreamPending,
} from "./forkChangelog.ts";
import {
  MachineMapClientState,
  MachineMapDesktopReport,
  MachineMapShareSettingsInput,
  MachineMapShareSettingsResult,
  MachineMapJoinInput,
  MachineMapPanelState,
  MachineMapRequestError,
} from "./machineMapClient.ts";
import {
  WebPushEndpointInput,
  WebPushError,
  WebPushPublicKey,
  WebPushSubscribeInput,
  WebPushTestResult,
} from "./webPush.ts";

export const FORK_WS_METHODS = {
  // Fork changelog (fork feature)
  forkChangelogListReleases: "forkChangelog.listReleases",
  forkChangelogReleaseChanges: "forkChangelog.releaseChanges",
  forkChangelogUpstreamPending: "forkChangelog.upstreamPending",
  forkChangelogSyncStatus: "forkChangelog.syncStatus",
  forkChangelogStartSync: "forkChangelog.startSync",

  // Fork: machine map (apps/machine-map/SPEC.md)
  machineMapSubscribe: "machineMap.subscribe",
  machineMapJoin: "machineMap.join",
  machineMapLeave: "machineMap.leave",
  machineMapReportDesktop: "machineMap.reportDesktop",
  machineMapShareSettings: "machineMap.shareSettings",
  machineMapRead: "machineMap.read",

  // Fork: Web Push (webPush.ts)
  webPushPublicKey: "webPush.publicKey",
  webPushSubscribe: "webPush.subscribe",
  webPushTest: "webPush.test",
} as const;

const forkChangelogError = Schema.Union([ForkChangelogError, EnvironmentAuthorizationError]);
const WsForkChangelogListReleasesRpc = Rpc.make(FORK_WS_METHODS.forkChangelogListReleases, {
  payload: Schema.Struct({}),
  success: ForkReleaseList,
  error: forkChangelogError,
});
const WsForkChangelogReleaseChangesRpc = Rpc.make(FORK_WS_METHODS.forkChangelogReleaseChanges, {
  payload: ForkReleaseChangesInput,
  success: ForkReleaseChanges,
  error: forkChangelogError,
});
const WsForkChangelogUpstreamPendingRpc = Rpc.make(FORK_WS_METHODS.forkChangelogUpstreamPending, {
  payload: Schema.Struct({}),
  success: ForkUpstreamPending,
  error: forkChangelogError,
});
const WsForkChangelogSyncStatusRpc = Rpc.make(FORK_WS_METHODS.forkChangelogSyncStatus, {
  payload: Schema.Struct({}),
  success: ForkSyncStatus,
  error: forkChangelogError,
});
const WsForkChangelogStartSyncRpc = Rpc.make(FORK_WS_METHODS.forkChangelogStartSync, {
  payload: Schema.Struct({}),
  success: ForkSyncStatus,
  error: forkChangelogError,
});

const machineMapError = Schema.Union([MachineMapRequestError, EnvironmentAuthorizationError]);
/** Fork: the local machine map state, again on each change. See `machineMapClient.ts`. */
const WsMachineMapSubscribeRpc = Rpc.make(FORK_WS_METHODS.machineMapSubscribe, {
  payload: Schema.Struct({}),
  success: MachineMapClientState,
  error: machineMapError,
  stream: true,
});
const WsMachineMapJoinRpc = Rpc.make(FORK_WS_METHODS.machineMapJoin, {
  payload: MachineMapJoinInput,
  success: MachineMapClientState,
  error: machineMapError,
});
const WsMachineMapLeaveRpc = Rpc.make(FORK_WS_METHODS.machineMapLeave, {
  payload: Schema.Struct({}),
  success: MachineMapClientState,
  error: machineMapError,
});
/** Fork: only the local desktop app reports. Other sessions get `desktop-only`. */
const WsMachineMapReportDesktopRpc = Rpc.make(FORK_WS_METHODS.machineMapReportDesktop, {
  payload: MachineMapDesktopReport,
  success: Schema.Struct({}),
  error: machineMapError,
});

/** Fork: MM-411. A change saved for all environments becomes the shared value of the map. */
const WsMachineMapShareSettingsRpc = Rpc.make(FORK_WS_METHODS.machineMapShareSettings, {
  payload: MachineMapShareSettingsInput,
  success: MachineMapShareSettingsResult,
  error: machineMapError,
});

/** Fork: MM-1701. `machines_read` through the portal connection, for the Machines panel. */
const WsMachineMapReadRpc = Rpc.make(FORK_WS_METHODS.machineMapRead, {
  payload: Schema.Struct({}),
  success: MachineMapPanelState,
  error: machineMapError,
});

const webPushError = Schema.Union([WebPushError, EnvironmentAuthorizationError]);
/** Fork: the key that a browser subscribes with, so that this server can push to it. */
const WsWebPushPublicKeyRpc = Rpc.make(FORK_WS_METHODS.webPushPublicKey, {
  payload: Schema.Struct({}),
  success: WebPushPublicKey,
  error: webPushError,
});
const WsWebPushSubscribeRpc = Rpc.make(FORK_WS_METHODS.webPushSubscribe, {
  payload: WebPushSubscribeInput,
  success: Schema.Struct({}),
  error: webPushError,
});
/** Fork: sends a test notification to one subscription of this server. */
const WsWebPushTestRpc = Rpc.make(FORK_WS_METHODS.webPushTest, {
  payload: WebPushEndpointInput,
  success: WebPushTestResult,
  error: webPushError,
});

export const ForkWsRpcGroup = RpcGroup.make(
  WsForkChangelogListReleasesRpc,
  WsForkChangelogReleaseChangesRpc,
  WsForkChangelogUpstreamPendingRpc,
  WsForkChangelogSyncStatusRpc,
  WsForkChangelogStartSyncRpc,
  WsMachineMapSubscribeRpc,
  WsMachineMapJoinRpc,
  WsMachineMapLeaveRpc,
  WsMachineMapReportDesktopRpc,
  WsMachineMapShareSettingsRpc,
  WsMachineMapReadRpc,
  WsWebPushPublicKeyRpc,
  WsWebPushSubscribeRpc,
  WsWebPushTestRpc,
);

/** The fork part of `CLIENT_GUARDED_RPC_SCOPES`. */
export const FORK_CLIENT_GUARDED_RPC_SCOPES = {
  // Fork: starts the Fork Sync workflow, which pushes to fork main on GitHub.
  [FORK_WS_METHODS.forkChangelogStartSync]: AuthSourceControlWriteScope,
  // Fork: joining or leaving the machine map turns the `machineMap` setting on or off.
  [FORK_WS_METHODS.machineMapJoin]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.machineMapLeave]: AuthSettingsWriteScope,
  // Fork: MM-411. Sets shared values of the map, like a settings change on every machine.
  [FORK_WS_METHODS.machineMapShareSettings]: AuthSettingsWriteScope,
  // Fork: the local desktop app reports desktop command results and its waiting update.
  [FORK_WS_METHODS.machineMapReportDesktop]: AuthEnvironmentMaintainScope,
} as const;

/** The fork RPCs that the server's `RPC_REQUIRED_SCOPES` adds to `CLIENT_GUARDED_RPC_SCOPES`. */
export const FORK_RPC_READ_SCOPES = {
  [FORK_WS_METHODS.forkChangelogListReleases]: AuthOrchestrationReadScope,
  [FORK_WS_METHODS.forkChangelogReleaseChanges]: AuthOrchestrationReadScope,
  [FORK_WS_METHODS.forkChangelogUpstreamPending]: AuthOrchestrationReadScope,
  [FORK_WS_METHODS.forkChangelogSyncStatus]: AuthOrchestrationReadScope,
  // Fork: machine map state for this server's clients. Only the desktop gets the token.
  [FORK_WS_METHODS.machineMapSubscribe]: AuthOrchestrationReadScope,
  // Fork: MM-1701. The same data that an agent with read access gets from `machines_read`.
  [FORK_WS_METHODS.machineMapRead]: AuthOrchestrationReadScope,
  // Fork: a subscription receives the thread titles of this server, which reading allows already.
  [FORK_WS_METHODS.webPushPublicKey]: AuthOrchestrationReadScope,
  [FORK_WS_METHODS.webPushSubscribe]: AuthOrchestrationReadScope,
  [FORK_WS_METHODS.webPushTest]: AuthOrchestrationReadScope,
} as const;
