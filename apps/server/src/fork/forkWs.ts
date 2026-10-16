/**
 * Fork WebSocket handlers and hooks. `ws.ts` merges `layerForkWsRpc` next to its own handler
 * layer and calls the helpers below, so the upstream file keeps one line per hook.
 */
import {
  FORK_WS_METHODS,
  ForkWsRpcGroup,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerResponse } from "effect/http";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ForkChangelog from "./ForkChangelog.ts";
import { requireLocalDesktop } from "./machineMap/browserAccess.ts";
import * as MachineMap from "./machineMap/MachineMap.ts";
import { isLocalDesktopSubject, isMachineSubject } from "./machineMap/machineAccess.ts";
import * as MachineMapState from "./machineMap/MachineMapState.ts";
import * as WebPush from "./webPush/WebPush.ts";

/** The fork RPC tags, which the upstream handler object in `ws.ts` omits. */
export const FORK_WS_RPC_TAGS = Object.values(FORK_WS_METHODS);

// A handler layer of its own: one handler object for every RPC is too deep a type for tsc.
export const layerForkWsRpc = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  ForkWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const forkChangelog = yield* ForkChangelog.ForkChangelog;
      const machineMap = yield* MachineMap.MachineMap;
      const webPush = yield* WebPush.WebPush;
      // Only the local desktop app gets the machine map token (MM-306, MM-1401).
      const machineMapClient = { desktop: isLocalDesktopSubject(currentSession.subject) };
      return ForkWsRpcGroup.of({
        [FORK_WS_METHODS.forkChangelogListReleases]: (_input) => forkChangelog.listReleases,
        [FORK_WS_METHODS.forkChangelogReleaseChanges]: (input) =>
          forkChangelog.releaseChanges(input),
        [FORK_WS_METHODS.forkChangelogUpstreamPending]: (_input) => forkChangelog.upstreamPending,
        [FORK_WS_METHODS.forkChangelogSyncStatus]: (_input) => forkChangelog.syncStatus,
        [FORK_WS_METHODS.forkChangelogStartSync]: (_input) => forkChangelog.startSync,
        [FORK_WS_METHODS.machineMapSubscribe]: (_input) =>
          machineMap.clientStates(machineMapClient),
        [FORK_WS_METHODS.machineMapJoin]: (input) =>
          requireLocalDesktop(machineMapClient).pipe(Effect.andThen(machineMap.join(input))),
        [FORK_WS_METHODS.machineMapLeave]: (_input) =>
          requireLocalDesktop(machineMapClient).pipe(Effect.andThen(machineMap.leave)),
        [FORK_WS_METHODS.machineMapReportDesktop]: (input) =>
          machineMap.reportDesktop(input, machineMapClient).pipe(Effect.as({})),
        [FORK_WS_METHODS.machineMapShareSettings]: (input) => machineMap.shareSettings(input),
        [FORK_WS_METHODS.machineMapRead]: (_input) =>
          // MM-1701: another machine reaches this server through an arrow, not a map role.
          // It must not read the map through the map role of this machine.
          isMachineSubject(currentSession.subject)
            ? Effect.succeed({
                _tag: "unavailable" as const,
                reason: "refused" as const,
                detail: "Other machines read the map with their own map role.",
              })
            : machineMap.readPanel,
        [FORK_WS_METHODS.webPushPublicKey]: (_input) =>
          webPush.publicKey.pipe(Effect.map((publicKey) => ({ publicKey }))),
        [FORK_WS_METHODS.webPushSubscribe]: (input) => webPush.subscribe(input).pipe(Effect.as({})),
        [FORK_WS_METHODS.webPushTest]: (input) => webPush.test(input.endpoint),
      });
    }),
  );

/** Machine map (MM-1311): peer machines join the explicit list of trusted browser origins. */
export const trustedBrowserOriginsConfig = (configured: ReadonlyArray<string> | undefined) =>
  Effect.serviceOption(MachineMapState.MachineMapState).pipe(
    Effect.map((machineMap) => {
      const origins = [
        ...new Set([
          ...(configured ?? []),
          ...(Option.isSome(machineMap) ? machineMap.value.peerOrigins() : []),
        ]),
      ];
      return origins.length === 0 ? {} : { trustedBrowserOrigins: origins };
    }),
  );

/**
 * A launch is accepted before its worktree exists, so a branch that cannot be created is refused
 * while the client can still act.
 */
export const checkLaunchWorktreeBranch = (
  threadLaunch: ThreadLaunchService.ThreadLaunchService["Service"],
  input: OrchestrationV2ThreadLaunchInput,
) =>
  input.workspaceStrategy.type === "worktree" &&
  input.workspaceStrategy.branch !== undefined &&
  !isTemporaryWorktreeBranch(input.workspaceStrategy.branch)
    ? threadLaunch
        .checkWorktreeBase({
          projectId: input.projectId,
          workspaceStrategy: input.workspaceStrategy,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2ThreadLaunchError({
                commandId: input.commandId,
                projectId: input.projectId,
                message: cause.message,
                cause,
              }),
          ),
        )
    : Effect.void;

/** MM-718: the pause closes the socket at once; the upgrade then refuses it. */
export const awaitMachineMapLock = (subject: string) =>
  Effect.serviceOption(MachineMapState.MachineMapState).pipe(
    Effect.flatMap((machineMapState) =>
      Option.isNone(machineMapState)
        ? Effect.never
        : machineMapState.value.awaitLockFor(subject).pipe(Effect.as(HttpServerResponse.empty())),
    ),
  );
