import { useState } from "react";

import type { PauseResponse, ResumeResponse } from "../api.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext, type Portal } from "./context.ts";
import { actorText, timeAgo } from "./format.ts";

/**
 * MM-708: the big red button. Lifting the cover is the confirmation, so one press then pauses
 * everything. `onPressed` lets a dialog close itself after the press.
 */
export function EmergencyButton({
  size,
  onPressed,
}: {
  size: "header" | "dialog";
  onPressed?: () => void;
}) {
  const portal = usePortalContext();
  const [coverOpen, setCoverOpen] = useState(false);
  const paused = portal.pause !== null;

  const press = () => {
    setCoverOpen(false);
    onPressed?.();
    portal.call(async () => {
      const result = await callApi<PauseResponse>("POST", "/api/pause");
      return `Everything is paused. Stop sent to ${result.stopCommands} machines.`;
    });
  };

  const hint = paused
    ? "Everything is paused"
    : coverOpen
      ? "Press to stop everything"
      : "Lift the cover first";

  return (
    <div className={`panic ${size}${paused ? " is-paused" : ""}`}>
      <span className="sticker panic-note">do not press for fun</span>
      <div className="panic-inner">
        <div className="panic-well">
          <button
            type="button"
            className="mushroom"
            disabled={!coverOpen || paused}
            onClick={press}
            aria-label="Stop everything"
          >
            {paused ? "PAUSED" : "STOP"}
          </button>
          {!paused && (
            <button
              type="button"
              className={`cover${coverOpen ? " open" : ""}`}
              aria-expanded={coverOpen}
              aria-label={coverOpen ? "Close the cover" : "Lift the cover"}
              onClick={() => setCoverOpen(!coverOpen)}
            >
              <span>{coverOpen ? "close" : "lift"}</span>
            </button>
          )}
        </div>
        <div className="panic-label">
          <b>BIG RED BUTTON</b>
          <span>{hint}</span>
        </div>
      </div>
    </div>
  );
}

/** MM-712: Resume asks once, then returns the arrows and map roles from before the pause. */
export const confirmResume = (portal: Portal): void =>
  portal.open({
    _tag: "confirm",
    title: "Resume everything?",
    body: "The arrows and map roles return to how they were before the pause, as one revision. Agents do not start again on their own.",
    confirmLabel: "Resume",
    tone: "primary",
    action: () =>
      portal.call(async () => {
        const result = await callApi<ResumeResponse>("POST", "/api/resume");
        return result.revision === null
          ? "Resumed. Nothing had to change."
          : `Resumed as rev ${result.revision}.`;
      }),
  });

/** MM-713: every page shows the pause, who paused and when, and the way out. */
export function PausedBanner() {
  const portal = usePortalContext();
  const pause = portal.pause;
  if (!pause) return null;
  return (
    <>
      <div className="paused-frame" aria-hidden />
      <section className="card paused-banner" role="alert">
        <div className="hazard" aria-hidden />
        <div className="paused-body">
          <span className="sticker paused-sticker">emergency pause</span>
          <div className="grow">
            <h2>Everything is paused</h2>
            <p className="muted">
              {actorText(pause.by, portal.map)} pressed the big red button{" "}
              {timeAgo(pause.pausedAt, portal.now)}. Agents got a stop, every arrow and map role is
              none, and agent tool calls are refused.
            </p>
          </div>
          <button type="button" className="btn primary big" onClick={() => confirmResume(portal)}>
            Resume
          </button>
        </div>
      </section>
    </>
  );
}
