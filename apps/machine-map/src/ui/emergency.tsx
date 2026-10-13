import { useId, useState } from "react";

import type { PauseResponse, ResumeResponse } from "../api.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext, type Portal } from "./context.ts";
import { pauseReach, type PauseReach } from "./derive.ts";
import { actorText, timeAgo } from "./format.ts";
import { CloseIcon } from "./icons.tsx";

const HINTS = {
  closed: "Lift the cover first",
  open: "Press to stop everything",
  paused: "Everything is paused",
} as const;

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

  const hint: keyof typeof HINTS = paused ? "paused" : coverOpen ? "open" : "closed";

  return (
    <div className={`panic ${size}${paused ? " is-paused" : ""}`}>
      <span className="sticker panic-note">hands off</span>
      <PauseInfo />
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
          {/* Every hint takes the same cell, so the box keeps one size in every state. */}
          <span className="panic-hint">
            {Object.entries(HINTS).map(([key, text]) => (
              <span
                key={key}
                className={key === hint ? "on" : undefined}
                aria-hidden={key !== hint}
              >
                {text}
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

const plural = (count: number, word: string): string =>
  `${count} ${count === 1 ? word : `${word}s`}`;

/** MM-709, MM-710: the reach of one press, with the counts of the current map. */
function reachText(reach: PauseReach): string {
  const offline = reach.offline > 0 ? ` (${reach.offline} offline)` : "";
  const stops = `Stops agents on ${plural(reach.machines, "machine")}${offline}.`;
  if (reach.arrows === 0 && reach.mapRoles === 0) {
    return `${stops} The map is already locked down, so no arrow or map role changes.`;
  }
  return `${stops} Drops ${plural(reach.arrows, "arrow")} and ${plural(reach.mapRoles, "map role")} to none.`;
}

/** MM-709 to MM-712 in plain words. Keep it true to the spec and to the pause in the Durable Object. */
const PAUSE_EFFECTS = [
  {
    label: "Stops",
    text: 'Sends "stop all agents" to every machine. An offline machine gets it when it connects again, for up to 7 days.',
  },
  {
    label: "Cuts",
    text: 'Every arrow and every map role becomes none, as one "Emergency pause" revision. Machines end the sessions of the other machines at once.',
  },
  {
    label: "Freezes",
    text: "Agent tool calls and every change that raises access are refused until Resume.",
  },
  {
    label: "Keeps",
    text: "Your own access through Cloudflare Access. Settings, lowering access and commands still work.",
  },
  {
    label: "Resume",
    text: "Returns the arrows and map roles from before the pause. It does not start agents again.",
  },
] as const;

/**
 * MM-708: the "i" button lists what one press does. The popover sits in the top layer and the
 * button sits on the frame edge, so neither moves the big red button.
 */
function PauseInfo() {
  const portal = usePortalContext();
  const id = useId();
  const pause = portal.pause;
  const title = "What the big red button does";
  return (
    <>
      <button type="button" className="panic-info" popoverTarget={id} aria-label={title}>
        i
      </button>
      <div id={id} popover="auto" className="card pause-info" role="dialog" aria-label={title}>
        <div className="pause-info-head">
          <h3>{pause ? "Everything is paused" : "One press does all of this"}</h3>
          <button type="button" className="btn small" popoverTarget={id} popoverTargetAction="hide">
            <CloseIcon />
            Close
          </button>
        </div>
        <p className="pause-info-now">
          {pause
            ? `${actorText(pause.by, portal.map)} pressed it ${timeAgo(pause.pausedAt, portal.now)}.`
            : reachText(pauseReach(portal.snapshot))}
        </p>
        <dl>
          {PAUSE_EFFECTS.map((effect) => (
            <div key={effect.label}>
              <dt>{effect.label}</dt>
              <dd>{effect.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
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
