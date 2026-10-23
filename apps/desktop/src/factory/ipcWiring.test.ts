// installDesktopIpcHandlers is upstream's list of channels; the factory line in it is the only
// thing that makes the pairing page's button reach the main process.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: { setBadgeCount: () => true, on: () => undefined, removeListener: () => undefined },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));

import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import { GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL } from "../ipc/channels.ts";
import { PAIR_FACTORY_SERVER_CHANNEL } from "./factoryServerChannel.ts";
import { layerIpcInstallDependencies, layerRecordingIpc } from "./testing.ts";

describe("desktop IPC handlers", () => {
  it.effect("register the factory pairing channel next to upstream's", () => {
    const channels: Array<string> = [];
    // The registered methods' own service needs are never used: the recording IPC only
    // takes their channel names.
    const install = installDesktopIpcHandlers() as unknown as Effect.Effect<void>;
    return install.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layerRecordingIpc(channels), layerIpcInstallDependencies)),
      Effect.tap(() =>
        Effect.sync(() => {
          assert.include(channels, GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL);
          assert.include(channels, PAIR_FACTORY_SERVER_CHANNEL);
        }),
      ),
    );
  });
});
