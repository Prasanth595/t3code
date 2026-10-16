import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Fork: Web Push on each environment. See `src/webPush.ts`. */
export const webPushPublicKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:web-push:public-key",
  tag: WS_METHODS.webPushPublicKey,
});

export const webPushSubscribe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:web-push:subscribe",
  tag: WS_METHODS.webPushSubscribe,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

export const webPushTest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:web-push:test",
  tag: WS_METHODS.webPushTest,
});
