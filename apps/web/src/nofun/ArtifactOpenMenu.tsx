import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { htmlRenderFileName, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { ChevronDownIcon, ExternalLinkIcon, FolderOpenIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useAssetUrlResolver } from "~/assets/assetUrls";
import { isElectron } from "~/env";
import { ensureLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import {
  artifactOpenMenuItems,
  artifactRevealLabel,
  type ArtifactOpenAction,
} from "./artifactOpen";

/**
 * The "Open in ..." choices for a No Fun artifact beyond the side panel: its
 * page in the default browser (a new tab on the web) and, in the desktop app,
 * its stored file revealed in the file manager.
 */
export function ArtifactOpenMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly variant: "outline" | "glass";
}) {
  const { attachmentId, title } = props.htmlRender;
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName: htmlRenderFileName(title),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, title],
  );
  const resolve = useAssetUrlResolver(props.environmentId, resource);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const items = artifactOpenMenuItems({
    revealLabel: artifactRevealLabel({
      isDesktop: isElectron,
      isPrimaryEnvironment: props.environmentId === primaryEnvironmentId,
      serverConfig,
    }),
  });

  const run = useCallback(
    async (action: ArtifactOpenAction) => {
      try {
        const resolved = await resolve();
        if (resolved === null) throw new Error("Unable to resolve the artifact.");
        if (action === "external-browser") {
          await ensureLocalApi().shell.openExternal(resolved.url);
          return;
        }
        if (resolved.sourcePath === undefined) throw new Error("The artifact has no stored file.");
        const result = await openInEditor({
          environmentId: props.environmentId,
          input: { cwd: resolved.sourcePath, editor: "file-manager", reveal: true },
        });
        if (result._tag === "Failure") throw new Error("Unable to reveal the artifact.");
      } catch {
        toastManager.add({
          type: "error",
          title:
            action === "external-browser"
              ? "Could not open the artifact in your browser"
              : "Could not reveal the artifact",
        });
      }
    },
    [openInEditor, props.environmentId, resolve],
  );

  return (
    <Menu>
      <MenuTrigger
        render={<Button aria-label="Open options" size="icon-xs" variant={props.variant} />}
      >
        <ChevronDownIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
        {items.map((item) => (
          <MenuItem key={item.action} onClick={() => void run(item.action)}>
            {item.action === "reveal" ? (
              <FolderOpenIcon className="size-4" />
            ) : (
              <ExternalLinkIcon className="size-4" />
            )}
            {item.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
