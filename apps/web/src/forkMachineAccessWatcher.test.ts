import { expect, it, vi } from "vite-plus/test";

import { createMachineAccessWatcher } from "./forkMachineAccessWatcher";

it.each([
  { machinePaused: true },
  { clientPending: { code: "ABCD", portalUrl: "https://portal.example" } },
  { clientPending: { code: null, portalUrl: "https://portal.example" } },
])("enters the root lock surface after a connected client is refused: %j", async (session) => {
  const reload = vi.fn();
  const read = vi.fn().mockResolvedValue(session);
  const watch = createMachineAccessWatcher(read, reload);
  await watch("connecting");
  expect(read).not.toHaveBeenCalled();
  await watch("connected");
  await watch("connecting");
  expect(reload).toHaveBeenCalledOnce();
  await watch("connecting");
  expect(read).toHaveBeenCalledOnce();
});

it("leaves ordinary disconnects and network errors on the retry path", async () => {
  const reload = vi.fn();
  const read = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("offline"));
  const watch = createMachineAccessWatcher(read, reload);
  await watch("connected");
  await watch("connecting");
  await watch("connected");
  await watch("connecting");
  expect(reload).not.toHaveBeenCalled();
});
