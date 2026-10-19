import { contextBridge, ipcRenderer } from "electron";

import { PAIR_FACTORY_SERVER_CHANNEL } from "./factoryServerChannel.ts";

/** Gives the web UI's pairing page a way to hand a pairing link to the main process. */
export function exposeFactoryDesktopBridge(): void {
  contextBridge.exposeInMainWorld("t3FactoryDesktop", {
    pairFactoryServer: (credential: string): Promise<void> =>
      ipcRenderer.invoke(PAIR_FACTORY_SERVER_CHANNEL, credential),
  });
}
