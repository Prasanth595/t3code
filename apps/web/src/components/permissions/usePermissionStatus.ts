import { useEffect, useEffectEvent, useState } from "react";

const PERMISSION_STATUS_POLL_MS = 1_500;

export function usePermissionStatus<Id extends string>(
  check: () => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
  enabled = true,
) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const checkLatest = useEffectEvent(check);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showing = () => document.visibilityState === "visible";
    const refresh = async () => {
      if (disposed || checking || !showing()) return;
      checking = true;
      try {
        const next = await checkLatest();
        if (!disposed) {
          setStatus(next);
          setError(null);
        }
      } catch {
        if (!disposed) setError("Could not check permissions. We'll try again automatically.");
      }
      checking = false;
    };
    // The timer exists only while the window is showing: a hidden tab needs
    // no permission answers, and the checks it missed collapse into the one
    // refresh on the way back. Nothing else re-arms the cadence.
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && showing()) {
        timer = setTimeout(() => void refresh().finally(schedule), PERMISSION_STATUS_POLL_MS);
      }
    };
    const onReturn = () => {
      if (!showing()) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      void refresh().finally(schedule);
    };
    void refresh().finally(schedule);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [enabled]);
  return {
    status,
    error,
    isReady: (required: readonly Id[]) => error === null && required.every((id) => status[id]),
  };
}
