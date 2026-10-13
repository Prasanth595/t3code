import { useRef, useState, type ReactNode } from "react";
import type { MachineKind, SettingScope } from "@t3tools/contracts/machineMap";

import type { JoinCodeResponse, WriteResult } from "../api.ts";
import { savePresetChange } from "../rules/presets.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext, type Dialog } from "./context.ts";
import { confirmResume, EmergencyButton } from "./emergency.tsx";
import { COMMAND_LABEL, LEVEL_LABEL, shortTime } from "./format.ts";
import { findArrow } from "../rules/map.ts";
import { VIEWS, type View } from "./route.ts";
import { knownKeys } from "./settingControls.ts";

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function DialogHost({ dialog, close }: { dialog: Dialog; close: () => void }) {
  switch (dialog._tag) {
    case "confirm":
      return (
        <Modal title={dialog.title} onClose={close}>
          <p className="muted">{dialog.body}</p>
          <div className="actions">
            <button
              type="button"
              className={`btn ${dialog.tone ?? "danger"}`}
              autoFocus
              onClick={() => {
                close();
                dialog.action();
              }}
            >
              {dialog.confirmLabel}
            </button>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
          </div>
        </Modal>
      );
    case "addMachine":
      return <AddMachineDialog close={close} />;
    case "joinCode":
      return (
        <Modal title={`Join code for ${dialog.machineName}`} onClose={close}>
          <div className="code">{dialog.code}</div>
          <p className="small muted">
            It works once and expires at {shortTime(dialog.expiresAt)}. Use it on the machine in T3
            Settings &gt; Machines, with <code>t3 machine-map join {dialog.code}</code>, or ask an
            agent there to call <code>machines_join</code>.
          </p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </div>
        </Modal>
      );
    case "newJoinCode":
      return (
        <NewJoinCodeDialog
          machineId={dialog.machineId}
          machineName={dialog.machineName}
          close={close}
        />
      );
    case "savePreset":
      return <SavePresetDialog close={close} />;
    case "manageSetting":
      return <ManageSettingDialog close={close} />;
    case "emergency":
      return (
        <Modal title="Emergency pause" onClose={close}>
          <p className="muted">
            Stops every agent on every machine, sets every arrow and map role to none, and refuses
            agent tool calls until you resume. Your own access stays.
          </p>
          <EmergencyButton size="dialog" onPressed={close} />
        </Modal>
      );
  }
}

/** MM-201, MM-210. */
function AddMachineDialog({ close }: { close: () => void }) {
  const portal = usePortalContext();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MachineKind>("laptop");
  const [existing, setExisting] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  return (
    <Modal title="Add machine" onClose={close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          const body = existing
            ? { name: trimmed, kind, tokenClientId: clientId.trim(), tokenSecret: secret.trim() }
            : { name: trimmed, kind };
          portal.call(async () => {
            const result = await callApi<JoinCodeResponse>("POST", "/api/machines", body);
            portal.open({
              _tag: "joinCode",
              machineName: trimmed,
              code: result.code,
              expiresAt: result.expiresAt,
            });
          });
        }}
      >
        <label className="field">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="Mac"
          />
        </label>
        <label className="field">
          Kind
          <select
            value={kind}
            onChange={(e) =>
              setKind(
                e.target.value === "server"
                  ? "server"
                  : e.target.value === "desktop"
                    ? "desktop"
                    : "laptop",
              )
            }
          >
            <option value="laptop">Laptop</option>
            <option value="desktop">Desktop</option>
            <option value="server">Server</option>
          </select>
        </label>
        <label className="actions small">
          <input
            type="checkbox"
            className="switch"
            checked={existing}
            onChange={(e) => setExisting(e.target.checked)}
          />
          Use an existing machine token
        </label>
        {existing ? (
          <>
            <label className="field">
              Client id
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </label>
            <label className="field">
              Client secret
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            <p className="small muted">
              The join code delivers this secret once. The portal never shows it again.
            </p>
          </>
        ) : (
          <p className="small muted">
            The portal creates the token <code>t3-machine-{name.trim() || "name"}</code> and adds it
            to the Access policies of the machine hostnames and of <code>/connect</code>.
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn primary">
            Add machine
          </button>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewJoinCodeDialog(props: { machineId: string; machineName: string; close: () => void }) {
  const portal = usePortalContext();
  const [secret, setSecret] = useState("");
  return (
    <Modal title={`New join code for ${props.machineName}`} onClose={props.close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const body = secret.trim() ? { tokenSecret: secret.trim() } : {};
          portal.call(async () => {
            const result = await callApi<JoinCodeResponse>(
              "POST",
              `/api/machines/${encodeURIComponent(props.machineId)}/join-code`,
              body,
            );
            portal.open({
              _tag: "joinCode",
              machineName: props.machineName,
              code: result.code,
              expiresAt: result.expiresAt,
            });
          });
        }}
      >
        <p className="small muted">
          Leave the secret empty to let the portal rotate the token. The old secret then stops at
          once. Without the Cloudflare API token, give the current secret.
        </p>
        <label className="field">
          Token secret (optional)
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </label>
        <div className="actions">
          <button type="submit" className="btn primary">
            Make join code
          </button>
          <button type="button" className="btn" onClick={props.close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** MM-705. */
function SavePresetDialog({ close }: { close: () => void }) {
  const portal = usePortalContext();
  const [name, setName] = useState("");
  return (
    <Modal title="Save arrows as a preset" onClose={close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          portal.submit(`Saved preset ${trimmed}`, [
            savePresetChange(portal.map, trimmed, new Date().toISOString()),
          ]);
          close();
        }}
      >
        <label className="field">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="Work day"
          />
        </label>
        <div className="actions">
          <button type="submit" className="btn primary">
            Save
          </button>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** MM-406: manage a setting, with the current value of one machine as the shared value. */
function ManageSettingDialog({ close }: { close: () => void }) {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const [scope, setScope] = useState<SettingScope>("server");
  const [machineId, setMachineId] = useState(map.machines[0]?.id ?? "");
  const [key, setKey] = useState("");
  const reported = snapshot.reportedSettings[machineId]?.[scope] ?? {};
  const keys = [...new Set([...knownKeys(scope), ...Object.keys(reported)])]
    .filter((k) => !map.settings.managed.some((s) => s.scope === scope && s.key === k))
    .sort();
  const hasValue = Object.hasOwn(reported, key);
  return (
    <Modal title="Manage a setting" onClose={close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = key.trim();
          if (!trimmed) return;
          portal.submit(`Manage ${scope}.${trimmed}`, [
            { _tag: "manageSetting", scope, key: trimmed, managed: true },
            ...(hasValue
              ? [
                  {
                    _tag: "setSetting" as const,
                    machineId: null,
                    scope,
                    key: trimmed,
                    present: true,
                    value: reported[trimmed],
                  },
                ]
              : []),
          ]);
          close();
        }}
      >
        <div className="seg">
          {(["server", "client"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s === "server" ? "Server setting" : "Client setting"}
            </button>
          ))}
        </div>
        <label className="field">
          Take the value from
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {map.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Setting
          <input
            list="setting-keys"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
          <datalist id="setting-keys">
            {keys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </label>
        <div className="small muted">
          {key &&
            (hasValue
              ? `Shared value: ${JSON.stringify(reported[key])}`
              : "This machine did not report this setting.")}
        </div>
        <div className="actions">
          <button type="submit" className="btn primary">
            Manage
          </button>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface PaletteItem {
  readonly label: string;
  readonly kind: string;
  readonly run: () => void;
}

const VIEW_LABEL: Record<View, string> = {
  map: "Map",
  table: "Table",
  settings: "Settings",
  queue: "Queue",
  history: "History",
  inbox: "Inbox",
  devices: "Devices",
};

/** MM-1105: every action and every machine. */
export function Palette({ close, toggleHold }: { close: () => void; toggleHold: () => void }) {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const items = ((): Array<PaletteItem> => {
    const out: Array<PaletteItem> = [];
    for (const view of VIEWS) {
      out.push({
        label: `Go to ${VIEW_LABEL[view]}`,
        kind: "view",
        run: () => portal.select({ _tag: "none" }, view),
      });
    }
    out.push({
      label: "Add machine",
      kind: "action",
      run: () => portal.open({ _tag: "addMachine" }),
    });
    out.push({
      label: portal.draft ? "Stop holding changes" : "Hold changes",
      kind: "action",
      run: toggleHold,
    });
    out.push({
      label: "Save arrows as a preset",
      kind: "action",
      run: () => portal.open({ _tag: "savePreset" }),
    });
    out.push({
      label: "Manage a setting",
      kind: "action",
      run: () => portal.open({ _tag: "manageSetting" }),
    });
    // MM-708: the palette opens the big red button, so the cover still confirms the press.
    out.push(
      portal.pause
        ? {
            label: "Resume after emergency pause",
            kind: "action",
            run: () => confirmResume(portal),
          }
        : {
            label: "Emergency pause: stop everything",
            kind: "action",
            run: () => portal.open({ _tag: "emergency" }),
          },
    );
    out.push({
      label: "Lockdown",
      kind: "action",
      run: () =>
        portal.open({
          _tag: "confirm",
          title: "Lock down every machine?",
          body: "Every arrow and every map role becomes none. Your own access through Cloudflare Access stays.",
          confirmLabel: "Lock down",
          action: () =>
            portal.call(() => callApi<WriteResult>("POST", "/api/lockdown"), "Locked down."),
        }),
    });
    for (const preset of map.presets) {
      out.push({
        label: `Apply preset ${preset.name}`,
        kind: "preset",
        run: () =>
          portal.call(
            () =>
              callApi<WriteResult>("POST", `/api/presets/${encodeURIComponent(preset.name)}/apply`),
            `Applied ${preset.name}.`,
          ),
      });
    }
    for (const machine of map.machines) {
      out.push({
        label: machine.name,
        kind: "machine",
        run: () => portal.select({ _tag: "machine", id: machine.id }),
      });
      if (machine.hostname) {
        const url = `https://${machine.hostname}`;
        out.push({
          label: `Open ${machine.name}`,
          kind: "machine",
          run: () => window.open(url, "_blank", "noreferrer"),
        });
      }
      for (const kind of snapshot.presence[machine.id]?.status?.commands ?? []) {
        if (
          kind === "restartServer" ||
          kind === "stopAllAgents" ||
          kind === "collectDiagnostics" ||
          kind === "reloadWindows"
        ) {
          out.push({
            label: `${COMMAND_LABEL[kind]} on ${machine.name}`,
            kind: "command",
            run: () => portal.command(machine.id, { _tag: kind }),
          });
        }
      }
      for (const other of map.machines) {
        if (other.id === machine.id) continue;
        const level = findArrow(map, machine.id, other.id).level;
        out.push({
          label: `${machine.name} → ${other.name} (${LEVEL_LABEL[level]})`,
          kind: "arrow",
          run: () => portal.select({ _tag: "arrow", from: machine.id, to: other.id }),
        });
      }
    }
    return out;
  })();

  const words = query
    .toLowerCase()
    .split(" ")
    .filter((w) => w.length > 0);
  const shown = items.filter((item) =>
    words.every((w) => `${item.label} ${item.kind}`.toLowerCase().includes(w)),
  );
  const index = Math.min(active, Math.max(shown.length - 1, 0));

  const move = (next: number) => {
    setActive(next);
    list.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="card palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          placeholder="Find a machine or an action"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(Math.min(index + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(Math.max(index - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(shown[index]);
            }
          }}
        />
        <ul ref={list} role="listbox">
          {shown.map((item, i) => (
            <li
              key={`${item.kind}:${item.label}`}
              role="option"
              aria-selected={i === index}
              onPointerEnter={() => setActive(i)}
              onClick={() => run(item)}
            >
              <span>{item.label}</span>
              <span className="kind">{item.kind}</span>
            </li>
          ))}
          {shown.length === 0 && <li className="muted">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
