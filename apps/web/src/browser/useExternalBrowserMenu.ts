import { useCallback } from "react";
import {
  AuthFilesystemReadScope,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";

import { readLocalApi } from "../localApi";
import { assetEnvironment } from "../state/assets";
import { readPreparedConnection, readEnvironmentScope } from "../state/session";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { openAssetExternally } from "./openAssetExternally";

/** Context menus for captured HTML and document previews share the same fresh-URL opener. */
export function useExternalBrowserMenu(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
) {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(
    async (position: { x: number; y: number }, selectedAction?: "open-external") => {
      const api = readLocalApi();
      if (!api || !environmentId || !resource) return;
      try {
        const action =
          selectedAction ??
          (await api.contextMenu.show(
            [{ id: "open-external", label: "Open in external browser" }],
            position,
          ));
        if (action !== "open-external") return;
        const connection = readPreparedConnection(environmentId);
        if (!connection) throw new Error("Reconnect to this environment and try again.");
        await openAssetExternally({
          environmentId,
          resource,
          httpBaseUrl: connection.httpBaseUrl,
          assertCanOpen: () => {
            if (
              (resource._tag === "media-file" ||
                resource._tag === "workspace-file" ||
                resource._tag === "draft-workspace-file") &&
              !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
            )
              throw new Error("This connection cannot read host files.");
          },
          createAssetUrl,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in external browser",
            description: error instanceof Error ? error.message : "The file could not be opened.",
          }),
        );
      }
    },
    [environmentId, resource, createAssetUrl],
  );
}
