import { DesktopUpdateInstallCheckSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Fork: see apps/desktop/src/updates/forkUpdateInstall.ts. */
export const checkBeforeUpdateInstall = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_BEFORE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateInstallCheckSchema,
  handler: Effect.fn("desktop.ipc.updates.checkBeforeInstall")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.checkBeforeInstall;
  }),
});
