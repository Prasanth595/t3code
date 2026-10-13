import { useEffect, useMemo, useState } from "react";
import type {
  MachineCommand,
  MachineCommandInput,
  MachineId,
  MapChange,
  MapRevision,
} from "@t3tools/contracts/machineMap";

import type { HistoryResponse, WriteResult } from "../api.ts";
import { applyChanges } from "../rules/map.ts";
import { DEFAULT_COMMAND_MINUTES } from "../rules/queue.ts";
import { callApi } from "./apiClient.ts";
import {
  PortalContext,
  type CommandOptions,
  type Dialog,
  type DraftChange,
  type Portal,
  type SubmitOutcome,
} from "./context.ts";
import { machineQueue } from "./derive.ts";
import { DialogHost, Palette } from "./dialogs.tsx";
import { EmergencyButton, PausedBanner } from "./emergency.tsx";
import { COMMAND_LABEL, DANGEROUS_COMMANDS, machineName } from "./format.ts";
import { CloseIcon, UndoIcon } from "./icons.tsx";
import { MapView } from "./MapView.tsx";
import { Panel } from "./panels.tsx";
import {
  formatRoute,
  NO_SELECTION,
  parseRoute,
  VIEW_LABEL,
  VIEWS,
  type Selection,
  type View,
} from "./route.ts";
import { HealthView } from "./resources.tsx";
import { usePortal, type Connection } from "./store.ts";
import {
  DevicesView,
  HistoryView,
  InboxView,
  QueueView,
  SettingsView,
  TableView,
} from "./views.tsx";

/** Relative times refresh on this clock, not on a continuous animation (MM-1107). */
const CLOCK_MS = 30_000;
/** A good notice leaves on its own. An error stays until the owner closes it. */
const NOTICE_MS = 7000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Notice {
  readonly kind: "ok" | "error";
  readonly text: string;
  /** The revision that Undo reverses (MM-703). */
  readonly undo?: number;
}

/** The revision of an applied write, so its notice can offer Undo. */
const appliedRevision = (result: unknown): number | undefined =>
  typeof result === "object" &&
  result !== null &&
  "_tag" in result &&
  result._tag === "applied" &&
  "revision" in result &&
  typeof result.revision === "number"
    ? result.revision
    : undefined;

/** Text fields keep Escape for themselves. */
const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl K";

const CONNECTION_STICKER: Record<Connection, string> = {
  live: "ok",
  connecting: "wait",
  offline: "",
};

function Brand({ connection, revision }: { connection: Connection; revision: number | null }) {
  return (
    <div className="brand">
      <h1>
        <span className="brand-mark" aria-hidden>
          T3
        </span>{" "}
        Machines
      </h1>
      <span className="live">
        <span className={`sticker ${CONNECTION_STICKER[connection]}`}>{connection}</span>
        {revision !== null && <span className="mono muted">rev {revision}</span>}
      </span>
    </div>
  );
}

export function App() {
  const { state, connection } = usePortal();
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<ReadonlyArray<DraftChange> | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [palette, setPalette] = useState(false);
  const [older, setOlder] = useState<ReadonlyArray<MapRevision>>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    const onKey = (event: KeyboardEvent) => {
      // An open dialog handles its own keys: Escape closes it.
      if (document.querySelector("dialog[open]")) return;
      // MM-1105: Cmd+K on a Mac, Ctrl+K elsewhere.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
      } else if (event.key === "Escape" && !isTextField(event.target)) {
        // MM-1103: Escape ends the focus and closes the side panel.
        const current = parseRoute(location.hash);
        if (current.selection._tag !== "none")
          location.hash = formatRoute({ view: current.view, selection: NO_SELECTION });
      }
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    if (notice?.kind !== "ok") return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const snapshot = state.snapshot;
  const proposals = snapshot?.proposals.length ?? 0;
  useEffect(() => {
    const parts = [VIEW_LABEL[route.view], "T3 machines"];
    if (state.pause) parts.unshift("Paused");
    document.title = `${proposals > 0 ? `(${proposals}) ` : ""}${parts.join(" · ")}`;
  }, [route.view, state.pause, proposals]);

  const draftView = useMemo(() => {
    if (!snapshot) return null;
    const changes = draft?.flatMap((d) => d.changes) ?? [];
    if (changes.length === 0) return { map: snapshot.map, error: null };
    try {
      return { map: applyChanges(snapshot.map, changes).map, error: null };
    } catch (error) {
      return { map: snapshot.map, error: `The draft no longer applies: ${errorText(error)}` };
    }
  }, [snapshot, draft]);

  const history = useMemo(() => {
    const seen = new Set<number>();
    return [...(snapshot?.history ?? []), ...older]
      .filter((r) => !seen.has(r.revision) && seen.add(r.revision))
      .sort((a, b) => b.revision - a.revision);
  }, [snapshot, older]);

  if (!snapshot || !draftView) {
    return (
      <div className="app">
        <header className="top">
          <Brand connection={connection} revision={null} />
        </header>
        <div className="card view empty" role="status">
          <h2>{connection === "offline" ? "The portal does not answer" : "Connecting"}</h2>
          <p>
            {connection === "offline"
              ? "The page tries again on its own. If this stays, the sign-in may have ended."
              : "Opening a live connection to the portal."}
          </p>
          {connection === "offline" && (
            <button type="button" className="btn" onClick={() => location.reload()}>
              Reload the page
            </button>
          )}
        </div>
      </div>
    );
  }

  const map = draftView.map;

  const call = (work: () => Promise<unknown>, done?: string) => {
    work()
      .then((result) => {
        const text = typeof result === "string" ? result : done;
        if (!text) return setNotice(null);
        const undo = appliedRevision(result);
        setNotice(undo === undefined ? { kind: "ok", text } : { kind: "ok", text, undo });
      })
      .catch((error: unknown) => setNotice({ kind: "error", text: errorText(error) }));
  };

  const select = (selection: Selection, view?: View) => {
    location.hash = formatRoute({ view: view ?? route.view, selection });
  };

  const submit = async (
    summary: string,
    changes: ReadonlyArray<MapChange>,
    options?: { readonly quiet: boolean },
  ): Promise<SubmitOutcome> => {
    if (draft) {
      try {
        applyChanges(map, changes);
      } catch (error) {
        setNotice({ kind: "error", text: errorText(error) });
        return { _tag: "failed" };
      }
      setDraft([...draft, { summary, changes }]);
      return { _tag: "held" };
    }
    try {
      const result = await callApi<WriteResult>("POST", "/api/changes", { summary, changes });
      if (result._tag === "proposed")
        setNotice({ kind: "ok", text: "The change waits in the Inbox." });
      else if (!options?.quiet)
        setNotice({ kind: "ok", text: `${summary}.`, undo: result.revision });
      return result;
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
      return { _tag: "failed" };
    }
  };

  const command = (machineId: MachineId, input: MachineCommandInput, options?: CommandOptions) => {
    const label = COMMAND_LABEL[input._tag];
    const name = machineName(map, machineId);
    const send = () =>
      call(async () => {
        const sent = await callApi<MachineCommand>("POST", "/api/commands", {
          machineId,
          input,
          delivery: options?.delivery ?? "online",
          expiresInMinutes: options?.expiresInMinutes ?? DEFAULT_COMMAND_MINUTES,
        });
        return sent.status === "queued"
          ? `${label} waits for ${name}. It runs when ${name} connects.`
          : `${label} sent to ${name}.`;
      });
    // MM-504.
    if (DANGEROUS_COMMANDS.has(input._tag)) {
      setDialog({
        _tag: "confirm",
        title: `${label} on ${name}?`,
        body:
          input._tag === "stopAllAgents"
            ? `Every running turn on ${name} stops. Agents do not start again on their own.`
            : `The T3 server on ${name} restarts. Open connections drop for a moment.`,
        confirmLabel: label,
        action: send,
      });
    } else {
      send();
    }
  };

  const undo = (revision: number) =>
    call(() => callApi<WriteResult>("POST", "/api/undo", { revision }), `Undid rev ${revision}.`);

  const portal: Portal = {
    snapshot,
    map,
    history,
    rotations: state.rotations,
    pause: state.pause,
    health: state.health,
    draft,
    now,
    route,
    submit,
    command,
    call,
    select,
    open: setDialog,
    loadOlderHistory: () =>
      call(async () => {
        const before = history.at(-1)?.revision;
        const page = await callApi<HistoryResponse>(
          "GET",
          `/api/history?limit=50${before ? `&before=${before}` : ""}`,
        );
        setOlder((current) => [...current, ...page.revisions]);
      }),
  };

  // MM-707.
  const toggleHold = () => {
    if (draft === null) setDraft([]);
    else if (draft.length === 0) setDraft(null);
    else
      setDialog({
        _tag: "confirm",
        title: "Discard the draft?",
        body: `${draft.length} held ${draft.length === 1 ? "change" : "changes"} will be lost.`,
        confirmLabel: "Discard",
        action: () => setDraft(null),
      });
  };
  const applyDraft = () => {
    if (!draft || draft.length === 0) return;
    const summary =
      draft.length === 1
        ? (draft[0]?.summary ?? "Draft")
        : `${draft.length} changes: ${draft.map((d) => d.summary).join("; ")}`;
    call(async () => {
      const result = await callApi<WriteResult>("POST", "/api/changes", {
        summary,
        changes: draft.flatMap((d) => d.changes),
      });
      setDraft(null);
      return result;
    }, "The draft is applied.");
  };

  const queued = map.machines.reduce(
    (sum, m) => sum + machineQueue(snapshot, state.rotations, m).count,
    0,
  );
  const counts: Partial<Record<View, number>> = { queue: queued, inbox: proposals };
  const hasPanel = route.selection._tag !== "none";
  const lockdown = () =>
    setDialog({
      _tag: "confirm",
      title: "Lock down every machine?",
      body: "Every arrow and every map role becomes none. Your own access through Cloudflare Access stays.",
      confirmLabel: "Lock down",
      action: () => call(() => callApi<WriteResult>("POST", "/api/lockdown"), "Locked down."),
    });

  const view = (() => {
    switch (route.view) {
      case "map":
        return <MapView map={map} readOnly={false} />;
      case "table":
        return <TableView />;
      case "health":
        return <HealthView />;
      case "settings":
        return <SettingsView />;
      case "queue":
        return <QueueView />;
      case "history":
        return <HistoryView />;
      case "inbox":
        return <InboxView />;
      case "devices":
        return <DevicesView />;
    }
  })();

  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- Every state change renders the whole page, so a memo saves nothing.
    <PortalContext.Provider value={portal}>
      <div className={`app${state.pause ? " paused" : ""}`}>
        <header className="top">
          <div className="top-main">
            <Brand connection={connection} revision={snapshot.map.revision} />
            <nav className="tabs" aria-label="Views">
              {VIEWS.map((v) => (
                <a
                  key={v}
                  href={formatRoute({ view: v, selection: route.selection })}
                  aria-current={route.view === v ? "page" : undefined}
                >
                  {VIEW_LABEL[v]}
                  {counts[v] ? (
                    <span className="count" aria-label={`${counts[v]} waiting`}>
                      {counts[v]}
                    </span>
                  ) : null}
                </a>
              ))}
            </nav>
          </div>
          <EmergencyButton size="header" />
        </header>

        <PausedBanner />

        {connection !== "live" && (
          <div className="card offline-note" role="status">
            <span className="sticker">{connection}</span>
            <span>
              The live connection dropped. You see the last known map, and changes may fail until
              the page reconnects on its own.
            </span>
          </div>
        )}

        <div className="toolbar">
          <button
            type="button"
            className="btn primary"
            onClick={() => setDialog({ _tag: "addMachine" })}
          >
            Add machine
          </button>
          <button type="button" className="btn" aria-pressed={draft !== null} onClick={toggleHold}>
            {draft === null ? "Hold changes" : "Stop holding"}
          </button>
          <span className="group">
            <select
              value=""
              aria-label="Apply a preset"
              disabled={map.presets.length === 0}
              onChange={(e) => {
                const name = e.target.value;
                if (name) {
                  call(
                    () =>
                      callApi<WriteResult>(
                        "POST",
                        `/api/presets/${encodeURIComponent(name)}/apply`,
                      ),
                    `Applied ${name}.`,
                  );
                }
              }}
            >
              <option value="">
                {map.presets.length === 0 ? "No presets yet" : "Apply preset…"}
              </option>
              {map.presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => setDialog({ _tag: "savePreset" })}>
              Save as preset
            </button>
          </span>
          <span className="spacer" />
          <button type="button" className="btn danger" onClick={lockdown}>
            Lockdown
          </button>
          <button type="button" className="btn" onClick={() => setPalette(true)}>
            Search <kbd>{SHORTCUT}</kbd>
          </button>
        </div>

        {draft !== null && (
          <div className="card draft">
            <span className="sticker wait">draft</span>
            <span className="grow">
              {draft.length === 0
                ? "Holding changes. New changes wait here until you apply them."
                : `${draft.length} held: ${draft.map((d) => d.summary).join("; ")}`}
              {draftView.error && <span className="error-text"> {draftView.error}</span>}
            </span>
            <button
              type="button"
              className="btn primary"
              disabled={draft.length === 0}
              onClick={applyDraft}
            >
              Apply
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Discard
            </button>
          </div>
        )}

        <div className={`layout${hasPanel ? " sheet-open" : " solo"}`}>
          <main>{view}</main>
          {hasPanel && (
            <Panel
              key={formatRoute({ view: "map", selection: route.selection })}
              selection={route.selection}
            />
          )}
        </div>

        {notice && (
          <div
            className={`card toast ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.kind === "error" && <span className="sticker">error</span>}
            <span className="text">{notice.text}</span>
            {notice.undo !== undefined && (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const revision = notice.undo;
                  setNotice(null);
                  if (revision !== undefined) undo(revision);
                }}
              >
                <UndoIcon />
                Undo
              </button>
            )}
            <button
              type="button"
              className="btn small icon-only"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <CloseIcon />
            </button>
          </div>
        )}

        {palette && <Palette close={() => setPalette(false)} toggleHold={toggleHold} />}
        {dialog && <DialogHost dialog={dialog} close={() => setDialog(null)} />}
      </div>
    </PortalContext.Provider>
  );
}
