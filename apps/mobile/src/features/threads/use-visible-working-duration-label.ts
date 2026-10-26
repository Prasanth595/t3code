import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { useIsFocused } from "@react-navigation/native";
import { useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppActive } from "../../lib/appState";

function durationLabel(nowMs: number, startedAtMs: number): string | null {
  return Number.isFinite(startedAtMs)
    ? ` ${formatWorkingDurationLabel(nowMs - startedAtMs)}`
    : null;
}

export function useVisibleWorkingDurationLabel(startedAt: string | null): string | null {
  const startedAtMs = useMemo(() => Date.parse(startedAt ?? ""), [startedAt]);
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [mountedAtMs] = useState(() => Date.now());
  const [label, setLabel] = useState(() => durationLabel(mountedAtMs, startedAtMs));
  const sample = useRef({ nowMs: mountedAtMs, label });
  const ticking = Number.isFinite(startedAtMs) && focused && appActive;

  const publish = useEffectEvent((nowMs: number, startMs = startedAtMs) => {
    const next = durationLabel(nowMs, startMs);
    sample.current.nowMs = nowMs;
    if (sample.current.label === next) return;
    sample.current.label = next;
    setLabel(next);
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- Rebind the retained sample before paint without shifting the interval, including while hidden.
  useLayoutEffect(() => {
    publish(sample.current.nowMs, startedAtMs);
  }, [startedAtMs]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Own the visible interval and refresh the paused clock before paint on resume.
  useLayoutEffect(() => {
    if (!ticking) return;
    publish(Date.now());
    const intervalId = setInterval(() => publish(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [ticking]);

  return label;
}
