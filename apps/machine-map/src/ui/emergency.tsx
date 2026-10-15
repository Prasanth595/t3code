import { useId, useState } from "react";

import type { PauseResponse, ResumeResponse } from "../api.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext, type Portal } from "./context.ts";
import { pauseReach, type PauseReach } from "./derive.ts";
import { actorText, timeAgo } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import {
  playCoverSound,
  playPanicSound,
  playResumeSound,
  showPanicEffects,
} from "./panicEffects.ts";

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
    playPanicSound();
    showPanicEffects();
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
              onClick={() => {
                playCoverSound(!coverOpen);
                setCoverOpen(!coverOpen);
              }}
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

/**
 * MM-709 to MM-712 in plain words, with the counts of the current map. Keep it true to the spec
 * and to the pause in the Durable Object. While paused, the counts are gone, so the lines are plain.
 */
function pauseEffects(reach: PauseReach | null) {
  const offline = reach && reach.offline > 0 ? ` (${reach.offline} offline)` : "";
  const notJoined =
    reach && reach.notJoined > 0
      ? ` Skips ${plural(reach.notJoined, "machine")} that never connected.`
      : "";
  const cut = [
    reach && reach.arrows > 0 ? plural(reach.arrows, "arrow") : null,
    reach && reach.mapRoles > 0 ? plural(reach.mapRoles, "map role") : null,
  ].filter((part) => part !== null);
  return [
    {
      label: "stop",
      tone: "paused-sticker",
      text: reach
        ? `Agents on ${plural(reach.machines, "machine")}${offline}. Offline ones stop when they connect, for up to 7 days.${notJoined}`
        : "Agents on every machine that joined. Offline ones stop when they connect, for up to 7 days.",
    },
    {
      label: "cut",
      tone: "warn",
      text:
        reach && cut.length === 0
          ? "Nothing. Every arrow and map role is none already."
          : `To none: ${reach ? cut.join(" and ") : "every arrow and map role"}. Sessions between machines end.`,
    },
    { label: "freeze", tone: "info", text: "Agent tools and any raise of access are refused." },
    { label: "keep", tone: "ok", text: "Your own login, settings, commands and lowering access." },
  ] as const;
}

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
        <div className="hazard" aria-hidden />
        <div className="pause-info-body">
          <div className="pause-info-head">
            <h3>{pause ? "Paused" : "What it does"}</h3>
            <button
              type="button"
              className="btn small"
              popoverTarget={id}
              popoverTargetAction="hide"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
          {pause && (
            <p className="pause-info-now">
              {actorText(pause.by, portal.map)} pressed it {timeAgo(pause.pausedAt, portal.now)}.
            </p>
          )}
          <ul className="pause-info-effects">
            {pauseEffects(pause ? null : pauseReach(portal.snapshot)).map((effect) => (
              <li key={effect.label}>
                <span className={`sticker ${effect.tone}`}>{effect.label}</span>
                <span>{effect.text}</span>
              </li>
            ))}
          </ul>
          <p className="pause-info-resume">
            <b>Resume</b> puts arrows and map roles back. Agents stay stopped.
          </p>
        </div>
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
    action: () => {
      playResumeSound();
      return portal.call(async () => {
        const result = await callApi<ResumeResponse>("POST", "/api/resume");
        return result.revision === null
          ? "Resumed. Nothing had to change."
          : `Resumed as rev ${result.revision}.`;
      });
    },
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
