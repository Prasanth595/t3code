import { MACHINE_PAUSED_MESSAGE } from "@t3tools/client-runtime/connection";
import { useEffect, useRef } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { fetchSessionState } from "../../environments/primary";
import { usePrimaryEnvironment } from "../../state/environments";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const UNLOCK_CHECK_INTERVAL_MS = 5_000;

/** Fork: MM-718. Replaces the whole app while the machine map pause locks this client. */
export function MachinePausedSurface() {
  useEffect(() => {
    // Resume needs no action here: the next check after it loads the app again.
    const timer = window.setInterval(() => {
      void fetchSessionState().then(
        (session) => {
          if (session.machinePaused !== true) window.location.reload();
        },
        () => undefined,
      );
    }, UNLOCK_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <StandalonePage tone="error">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Paused"
        description={MACHINE_PAUSED_MESSAGE}
      />
    </StandalonePage>
  );
}

/**
 * Fork: MM-718. The pause closes the socket of this client. When the primary connection drops,
 * one session check tells a pause apart from a network failure, and a pause loads the lock page.
 */
export function MachinePauseWatcher() {
  const phase = usePrimaryEnvironment()?.connection.phase;
  const wasConnected = useRef(false);
  useEffect(() => {
    if (phase === "connected") {
      wasConnected.current = true;
      return;
    }
    if (!wasConnected.current) return;
    wasConnected.current = false;
    void fetchSessionState().then(
      (session) => {
        if (session.machinePaused === true) window.location.reload();
      },
      () => undefined,
    );
  }, [phase]);
  return null;
}
