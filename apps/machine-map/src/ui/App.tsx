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
} from "./context.ts";
import { machineQueue } from "./derive.ts";
import { DialogHost, Palette } from "./dialogs.tsx";
import { EmergencyButton, PausedBanner } from "./emergency.tsx";
import { COMMAND_LABEL, DANGEROUS_COMMANDS, machineName } from "./format.ts";
import { MapView } from "./MapView.tsx";
import { Panel } from "./panels.tsx";
import { formatRoute, parseRoute, VIEWS, type Selection, type View } from "./route.ts";
import { usePortal } from "./store.ts";
import {
  DevicesView,
  HistoryView,
  InboxView,
  QueueView,
  SettingsView,
  TableView,
} from "./views.tsx";

const VIEW_LABEL: Record<View, string> = {
  map: "Map",
  table: "Table",
  settings: "Settings",
  queue: "Queue",
  history: "History",
  inbox: "Inbox",
  devices: "Devices",
};

/** Relative times refresh on this clock, not on a continuous animation (MM-1107). */
const CLOCK_MS = 30_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function App() {
  const { state, connection } = usePortal();
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<ReadonlyArray<DraftChange> | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [palette, setPalette] = useState(false);
  const [older, setOlder] = useState<ReadonlyArray<MapRevision>>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    // MM-1105: Cmd+K on a Mac, Ctrl+K elsewhere.
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      } else if (event.key === "Escape") {
        setPalette(false);
        setDialog(null);
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

  const snapshot = state.snapshot;
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
        <div className="card view empty">
          <h2>{connection === "offline" ? "The portal does not answer" : "Connecting"}</h2>
          <p>
            {connection === "offline"
              ? "The page retries on its own."
              : "The page opens a live connection to the portal."}
          </p>
        </div>
      </div>
    );
  }

  const map = draftView.map;

  const call = (work: () => Promise<unknown>, done?: string) => {
    work()
      .then((result) => {
        const text = typeof result === "string" ? result : done;
        setNotice(text ? { kind: "ok", text } : null);
      })
      .catch((error: unknown) => setNotice({ kind: "error", text: errorText(error) }));
  };

  const select = (selection: Selection, view?: View) => {
    location.hash = formatRoute({ view: view ?? route.view, selection });
  };

  const submit = (summary: string, changes: ReadonlyArray<MapChange>) => {
    if (draft) {
      try {
        applyChanges(map, changes);
        setDraft([...draft, { summary, changes }]);
      } catch (error) {
        setNotice({ kind: "error", text: errorText(error) });
      }
      return;
    }
    call(async () => {
      const result = await callApi<WriteResult>("POST", "/api/changes", { summary, changes });
      return result._tag === "applied" ? undefined : "The change waits in the Inbox.";
    });
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
          ? `${label} waits for ${name}.`
          : `${label} sent to ${name}.`;
      });
    // MM-504.
    if (DANGEROUS_COMMANDS.has(input._tag)) {
      setDialog({
        _tag: "confirm",
        title: `${label} on ${name}?`,
        body: "This interrupts work on the machine.",
        confirmLabel: label,
        action: send,
      });
    } else {
      send();
    }
  };

  const portal: Portal = {
    snapshot,
    map,
    history,
    rotations: state.rotations,
    pause: state.pause,
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
        body: `${draft.length} held changes will be lost.`,
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
      await callApi<WriteResult>("POST", "/api/changes", {
        summary,
        changes: draft.flatMap((d) => d.changes),
      });
      setDraft(null);
    }, "The draft is applied.");
  };

  const queued = map.machines.reduce(
    (sum, m) => sum + machineQueue(snapshot, state.rotations, m).count,
    0,
  );
  const counts: Partial<Record<View, number>> = { queue: queued, inbox: snapshot.proposals.length };
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
            <div className="brand">
              <h1>
                <span className="brand-mark">T3</span> Machines
              </h1>
              <span
                className={`sticker live ${connection === "live" ? "ok" : connection === "connecting" ? "wait" : ""}`}
              >
                {connection === "live"
                  ? `Live · rev ${snapshot.map.revision}`
                  : connection === "connecting"
                    ? "Connecting"
                    : "Offline · retrying"}
              </span>
            </div>
            <nav className="tabs" role="tablist" aria-label="Views">
              {VIEWS.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={route.view === v}
                  onClick={() => {
                    location.hash = formatRoute({ view: v, selection: route.selection });
                  }}
                >
                  {VIEW_LABEL[v]}
                  {counts[v] ? <span className="count">{counts[v]}</span> : null}
                </button>
              ))}
            </nav>
          </div>
          <EmergencyButton size="header" />
        </header>

        <PausedBanner />

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
          <select
            value=""
            onChange={(e) => {
              const name = e.target.value;
              if (name) {
                call(
                  () =>
                    callApi<WriteResult>("POST", `/api/presets/${encodeURIComponent(name)}/apply`),
                  `Applied ${name}.`,
                );
              }
            }}
          >
            <option value="">Apply preset…</option>
            {map.presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => setDialog({ _tag: "savePreset" })}>
            Save as preset
          </button>
          <button type="button" className="btn danger" onClick={lockdown}>
            Lockdown
          </button>
          <button type="button" className="btn" onClick={() => setPalette(true)}>
            Search <span className="mono">⌘K</span>
          </button>
        </div>

        {notice && (
          <div className={`card notice ${notice.kind}`}>
            <span className="text">{notice.text}</span>
            <button type="button" className="btn small" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        {draft !== null && (
          <div className="card draft">
            <span className="sticker wait">draft</span>
            <span className="grow">
              {draft.length === 0
                ? "Holding changes. New changes wait here until you apply them."
                : `${draft.length} held: ${draft.map((d) => d.summary).join("; ")}`}
            </span>
            {draftView.error && (
              <span className="small" style={{ color: "var(--error-fg)" }}>
                {draftView.error}
              </span>
            )}
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
          {hasPanel && <Panel selection={route.selection} />}
        </div>

        {palette && <Palette close={() => setPalette(false)} toggleHold={toggleHold} />}
        {dialog && <DialogHost dialog={dialog} close={() => setDialog(null)} />}
      </div>
    </PortalContext.Provider>
  );
}
