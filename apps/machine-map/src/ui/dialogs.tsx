import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MachineKind, MapPosition, SettingScope } from "@t3tools/contracts/machineMap";

import {
  FORK_RELEASES_PAGE,
  type AddMachineRequest,
  type ForkRelease,
  type JoinCodeResponse,
  type WriteResult,
} from "../api.ts";
import { usesText } from "../rules/access.ts";
import { findArrow } from "../rules/map.ts";
import { savePresetChange } from "../rules/presets.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext, type Dialog } from "./context.ts";
import { confirmResume, EmergencyButton } from "./emergency.tsx";
import { COMMAND_LABEL, LEVEL_LABEL, timeUntil } from "./format.ts";
import { ChevronDownIcon, CopyIcon, KindIcon } from "./icons.tsx";
import { INSTALL_TARGET_LABEL, installCommand, type InstallTarget } from "./install.ts";
import { VIEW_LABEL, VIEWS } from "./route.ts";
import { knownKeys } from "./settingControls.ts";

/**
 * A native modal dialog: it keeps focus inside, closes on Escape and on a tap outside, and gives
 * focus back to where it was. The element with `data-autofocus` gets focus first.
 */
function Modal({
  title,
  onClose,
  className = "modal",
  children,
}: {
  title: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOutside = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`card ${className}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The dialog box has no padding, so only the backdrop is the dialog element itself.
      onPointerDown={(e) => {
        downOutside.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOutside.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <h2 id={titleId} className={className === "palette" ? "sr-only" : undefined}>
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}

/** A dialog action in flight: the button waits, and an error shows in the dialog, not behind it. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    work()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setPending(false));
  };
  return { pending, error, run };
}

const ErrorLine = ({ error }: { error: string | null }) =>
  error ? (
    <p className="error-text" role="alert">
      {error}
    </p>
  ) : null;

export function DialogHost({ dialog, close }: { dialog: Dialog; close: () => void }) {
  switch (dialog._tag) {
    case "confirm": {
      const tone = dialog.tone ?? "danger";
      return (
        <Modal title={dialog.title} onClose={close}>
          <p className="muted">{dialog.body}</p>
          <div className="actions end">
            {/* A dangerous action never takes Enter by default. */}
            <button
              type="button"
              className="btn"
              onClick={close}
              data-autofocus={tone === "danger" || undefined}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${tone}`}
              data-autofocus={tone === "primary" || undefined}
              onClick={() => {
                close();
                dialog.action();
              }}
            >
              {dialog.confirmLabel}
            </button>
          </div>
        </Modal>
      );
    }
    case "addMachine":
      return <AddMachineDialog position={dialog.position} close={close} />;
    case "joinCode":
      return (
        <JoinCodeDialog
          machineName={dialog.machineName}
          code={dialog.code}
          expiresAt={dialog.expiresAt}
          close={close}
        />
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
          <div className="actions end">
            <button type="button" className="btn" onClick={close} data-autofocus>
              Cancel
            </button>
          </div>
        </Modal>
      );
  }
}

const KINDS: ReadonlyArray<{ kind: MachineKind; label: string }> = [
  { kind: "laptop", label: "Laptop" },
  { kind: "desktop", label: "Desktop" },
  { kind: "server", label: "Server" },
];

/** MM-201, MM-210. */
function AddMachineDialog({
  position,
  close,
}: {
  position: MapPosition | undefined;
  close: () => void;
}) {
  const portal = usePortalContext();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MachineKind>("laptop");
  const [existing, setExisting] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const action = useAction();
  const taken = portal.map.machines.some((m) => m.name.toLowerCase() === name.trim().toLowerCase());
  return (
    <Modal title="Add machine" onClose={close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          const body: AddMachineRequest = {
            name: trimmed,
            kind,
            ...(position ? { position } : {}),
            ...(existing ? { tokenClientId: clientId.trim(), tokenSecret: secret.trim() } : {}),
          };
          action.run(async () => {
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
            data-autofocus
            required
            autoComplete="off"
            placeholder="Mac"
          />
          {taken && <span className="hint">Another machine already has this name.</span>}
        </label>
        <div className="field" role="group" aria-label="Kind">
          Kind
          <div className="seg kinds">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                aria-pressed={kind === k.kind}
                onClick={() => setKind(k.kind)}
              >
                <KindIcon kind={k.kind} />
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <label className="toggle">
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
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              Client secret
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
                autoComplete="off"
              />
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
        <ErrorLine error={action.error} />
        <div className="actions end">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={action.pending}>
            {action.pending ? "Adding…" : "Add machine"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** MM-202, MM-203: the code works once, so the dialog makes it easy to copy. */
function JoinCodeDialog(props: {
  machineName: string;
  code: string;
  expiresAt: string;
  close: () => void;
}) {
  const portal = usePortalContext();
  const [copied, setCopied] = useState<"code" | "command" | null>(null);
  const command = `t3 machine-map join ${props.code}`;
  const copy = (what: "code" | "command", text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  return (
    <Modal title={`Join code for ${props.machineName}`} onClose={props.close}>
      <div className="code-row">
        <div className="code" aria-label="Join code">
          {props.code}
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => copy("code", props.code)}
          data-autofocus
        >
          <CopyIcon />
          {copied === "code" ? "Copied" : "Copy"}
        </button>
      </div>
      <InstallStep code={props.code} />
      <p className="small muted">
        It works once and expires {timeUntil(props.expiresAt, portal.now)}. On {props.machineName},
        use it in one of these ways:
      </p>
      <ol className="small steps">
        <li>In T3, open Settings &gt; Machines and paste the code.</li>
        <li>
          In a terminal, run <code>{command}</code>{" "}
          <button type="button" className="link" onClick={() => copy("command", command)}>
            {copied === "command" ? "copied" : "copy"}
          </button>
        </li>
        <li>
          Ask an agent there to call <code>machines_join</code> with the code.
        </li>
      </ol>
      <p className="small muted">The machine shows as waiting on the map until it connects.</p>
      <div className="actions end">
        <button type="button" className="btn primary" onClick={props.close}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/**
 * MM-211: step 0 of a join, for a machine without the fork. A split button copies the install
 * command; its menu holds the Mac and Windows commands and installers.
 */
function InstallStep({ code }: { code: string }) {
  const [release, setRelease] = useState<ForkRelease | null>(null);
  const [copied, setCopied] = useState<InstallTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    callApi<ForkRelease>("GET", "/api/fork-release").then(
      (result) => live && setRelease(result),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const copy = (target: InstallTarget) => {
    menu.current?.hidePopover();
    navigator.clipboard.writeText(installCommand(target, code)).then(
      () => setCopied(target),
      () => setCopied(null),
    );
  };
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  // Arrow keys, Home and End move between menu items. The popover closes itself on Escape.
  const onMenuKey = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? (at + 1) % all.length
        : e.key === "ArrowUp"
          ? (at - 1 + all.length) % all.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? all.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    all[next]?.focus();
  };
  const download = (label: string, url: string | null) =>
    url && (
      <a role="menuitem" href={url} onClick={() => menu.current?.hidePopover()}>
        {label}
      </a>
    );
  return (
    <div className="install-step">
      <p className="small">
        <strong>0. Install T3 Code (Yarden-zamir's fork)</strong> if the machine does not run it:{" "}
        <a href={release?.pageUrl ?? FORK_RELEASES_PAGE} target="_blank" rel="noreferrer">
          {release?.version ?? "fork releases"}
        </a>
      </p>
      <div className="install-actions">
        <div className="split">
          <button type="button" className="btn small" onClick={() => copy("linux")}>
            <CopyIcon />
            {copied === "linux" ? "Copied" : "Copy curl"}
          </button>
          <button
            type="button"
            className="btn small icon-only"
            popoverTarget={menuId}
            aria-haspopup="menu"
            aria-controls={menuId}
            aria-expanded={menuOpen}
            aria-label="Mac and Windows install"
          >
            <ChevronDownIcon />
          </button>
        </div>
        <div
          ref={menu}
          id={menuId}
          popover="auto"
          role="menu"
          aria-label="Install on Mac or Windows"
          className="card install-menu"
          onKeyDown={onMenuKey}
          onToggle={(e) => {
            setMenuOpen(e.newState === "open");
            if (e.newState === "open") items()[0]?.focus();
          }}
        >
          <button type="button" role="menuitem" onClick={() => copy("mac")}>
            Copy Mac command
          </button>
          {download("Download Mac app (.dmg)", release?.macUrl ?? null)}
          <button type="button" role="menuitem" onClick={() => copy("windows")}>
            Copy Windows command
          </button>
          {download("Download Windows installer (.exe)", release?.windowsUrl ?? null)}
        </div>
        <span className="small muted" role="status">
          {copied && `${INSTALL_TARGET_LABEL[copied]} command copied.`}
        </span>
      </div>
    </div>
  );
}

function NewJoinCodeDialog(props: { machineId: string; machineName: string; close: () => void }) {
  const portal = usePortalContext();
  const [secret, setSecret] = useState("");
  const action = useAction();
  return (
    <Modal title={`New join code for ${props.machineName}`} onClose={props.close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const body = secret.trim() ? { tokenSecret: secret.trim() } : {};
          action.run(async () => {
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
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            data-autofocus
          />
        </label>
        <ErrorLine error={action.error} />
        <div className="actions end">
          <button type="button" className="btn" onClick={props.close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={action.pending}>
            {action.pending ? "Making…" : "Make join code"}
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
  const replaces = portal.map.presets.some((p) => p.name === name.trim());
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
        <p className="small muted">
          A preset keeps every arrow as it is now. Apply it later in one step.
        </p>
        <label className="field">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-autofocus
            required
            autoComplete="off"
            placeholder="Work day"
          />
          {replaces && <span className="hint">This replaces the preset with the same name.</span>}
        </label>
        <div className="actions end">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
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
  const trimmed = key.trim();
  const hasValue = Object.hasOwn(reported, trimmed);
  const listId = useId();
  return (
    <Modal title="Manage a setting" onClose={close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
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
        <div className="seg" role="group" aria-label="Scope">
          {(["server", "client"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s === "server" ? "Server setting" : "Client setting"}
            </button>
          ))}
        </div>
        <label className="field">
          Setting
          <input
            list={listId}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            data-autofocus
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="Start typing a setting name"
          />
          <datalist id={listId}>
            {keys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </label>
        <label className="field">
          Take the shared value from
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {map.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="hint">
            {!trimmed
              ? "The map copies the value that this machine reports."
              : hasValue
                ? `Shared value: ${JSON.stringify(reported[trimmed])}`
                : "This machine did not report this setting. The shared value stays empty."}
          </span>
        </label>
        <div className="actions end">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!trimmed}>
            Manage
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

/** MM-1105: every action and every machine. */
export function Palette({ close, toggleHold }: { close: () => void; toggleHold: () => void }) {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

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
          label: `${usesText(machine.name, other.name)}: ${LEVEL_LABEL[level]}`,
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
  // A whole word beats the start of a word, which beats a match inside a word: "mac" finds the
  // machine Mac before "Add machine".
  const score = (item: PaletteItem) => {
    const parts = item.label.toLowerCase().split(" ");
    return words.reduce(
      (sum, w) => sum + (parts.includes(w) ? 2 : parts.some((p) => p.startsWith(w)) ? 1 : 0),
      0,
    );
  };
  const shown = items
    .filter((item) => words.every((w) => `${item.label} ${item.kind}`.toLowerCase().includes(w)))
    .map((item) => ({ item, score: score(item) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
  const index = Math.min(active, Math.max(shown.length - 1, 0));
  const optionId = (i: number) => `${listId}-${i}`;

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
    <Modal title="Command palette" onClose={close} className="palette">
      <input
        data-autofocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={shown.length > 0 ? optionId(index) : undefined}
        aria-label="Find a machine or an action"
        placeholder="Find a machine or an action"
        autoComplete="off"
        spellCheck={false}
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
      <ul ref={list} id={listId} role="listbox" aria-label="Results">
        {shown.map((item, i) => (
          <li
            key={`${item.kind}:${item.label}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === index}
            onPointerMove={() => i !== index && setActive(i)}
            onClick={() => run(item)}
          >
            <span>{item.label}</span>
            <span className="kind">{item.kind}</span>
          </li>
        ))}
        {shown.length === 0 && <li className="muted nothing">Nothing matches “{query}”.</li>}
      </ul>
      <div className="palette-keys small muted" aria-hidden>
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> run
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </Modal>
  );
}
