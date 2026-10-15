import type { AuthSessionState } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { fetchSessionState } from "../../environments/primary";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const APPROVAL_CHECK_INTERVAL_MS = 5_000;

/**
 * Fork: MM-920. Replaces the whole app while this machine enforces client access and the key of
 * this browser waits for approval in the portal.
 */
export function ClientPendingSurface({
  pending,
}: {
  readonly pending: NonNullable<AuthSessionState["clientPending"]>;
}) {
  useEffect(() => {
    // The approval needs no action here: the next check after it loads the app.
    const timer = window.setInterval(() => {
      void fetchSessionState().then(
        (session) => {
          if (session.clientPending === undefined) window.location.reload();
        },
        () => undefined,
      );
    }, APPROVAL_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Waiting for approval"
        description={
          pending.code === null
            ? "This browser could not prove its key. Reload the page, or use a pairing link."
            : `Approve this browser in the machine map portal. Its code is ${pending.code}.`
        }
      />
      <div className="mt-6">
        <Button size="sm" render={<a href={pending.portalUrl} target="_blank" rel="noreferrer" />}>
          <ExternalLinkIcon className="size-3.5" />
          Open portal
        </Button>
      </div>
    </StandalonePage>
  );
}
