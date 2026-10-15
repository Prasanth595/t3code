import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  ClientId,
  MachineId,
  MachineKind,
  MachineLevel,
  MapPosition,
} from "@t3tools/contracts/machineMap";

import {
  FORK_RELEASES_PAGE,
  type AddMachineRequest,
  type ApprovalsStatus,
  type ForkRelease,
  type InviteRequest,
  type InviteResponse,
  type JoinCodeResponse,
  type WriteResult,
  type TunnelSetup,
} from "../api.ts";
import { usesText } from "../rules/access.ts";
import { findArrow, LEVELS } from "../rules/map.ts";
import { savePresetChange } from "../rules/presets.ts";
import { callApi, StepUpNeeded } from "./apiClient.ts";
import { usePortalContext, type Dialog } from "./context.ts";
import { confirmResume, EmergencyButton } from "./emergency.tsx";
import { COMMAND_LABEL, LEVEL_LABEL, timeUntil } from "./format.ts";
import { CopyIcon, KindIcon } from "./icons.tsx";
import { playJoinSound, showJoinEffects } from "./panicEffects.ts";
import { QrCodeSvg } from "./QrCode.tsx";
import {
  INSTALL_TARGET_LABEL,
  INSTALL_TARGETS,
  installCommand,
  type InstallTarget,
} from "./install.ts";
import { VIEW_LABEL, VIEWS } from "./route.ts";
import { importSharedChanges } from "./settingControls.ts";

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
          machineId={dialog.machineId}
          machineName={dialog.machineName}
          code={dialog.code}
          expiresAt={dialog.expiresAt}
          tunnel={dialog.tunnel}
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
    case "inviteApp":
      return (
        <InviteAppDialog
          close={close}
          {...(dialog.clientId ? { clientId: dialog.clientId } : {})}
        />
      );
    case "importSettings":
      return <ImportSettingsDialog close={close} />;
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
              machineId: result.machineId,
              machineName: trimmed,
              code: result.code,
              expiresAt: result.expiresAt,
              tunnel: result.tunnel,
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
            to the Access policies of the machine hostnames and of <code>/connect</code>. It also
            makes the tunnel of the machine.
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

/**
 * MM-202, MM-203: the code works once, so the dialog makes it easy to copy.
 * MM-212: the dialog celebrates once when the machine uses the code, or says that it expired.
 */
function JoinCodeDialog(props: {
  machineId: MachineId;
  machineName: string;
  code: string;
  expiresAt: string;
  tunnel: TunnelSetup | null;
  close: () => void;
}) {
  const portal = usePortalContext();
  const [copied, setCopied] = useState<"code" | "command" | null>(null);
  const [joinsAtOpen] = useState(() => portal.joins[props.machineId] ?? 0);
  const joined = (portal.joins[props.machineId] ?? 0) > joinsAtOpen;
  // The page clock ticks every 30 seconds, so "expired" can show up to 30 seconds late.
  const expired = !joined && portal.now >= Date.parse(props.expiresAt);
  const online = portal.snapshot.presence[props.machineId]?.online === true;
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!joined) return;
    playJoinSound();
    if (card.current) showJoinEffects(card.current);
  }, [joined]);
  const command = `t3 machine-map join ${props.code}`;
  const copy = (what: "code" | "command", text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  const codeCard = (
    <div
      ref={card}
      className={`code${joined ? " used" : ""}${expired ? " expired" : ""}`}
      aria-label="Join code"
    >
      {props.code}
      {joined && (
        <span className="stamp join-stamp" aria-hidden>
          joined
        </span>
      )}
    </div>
  );
  if (joined) {
    return (
      <Modal title={`Join code for ${props.machineName}`} onClose={props.close}>
        {codeCard}
        <p className="join-result" role="status">
          <b>{props.machineName} joined</b>
          <span className="muted">{online ? " · Connected" : " · Not connected yet"}</span>
        </p>
        <div className="actions end">
          <button type="button" className="btn" onClick={props.close}>
            Done
          </button>
          <button
            type="button"
            className="btn primary"
            data-autofocus
            onClick={() => {
              props.close();
              portal.select({ _tag: "machine", id: props.machineId });
            }}
          >
            Open machine
          </button>
        </div>
      </Modal>
    );
  }
  if (expired) {
    return (
      <Modal title={`Join code for ${props.machineName}`} onClose={props.close}>
        {codeCard}
        <p className="join-result" role="status">
          This code expired. Make a new code to join {props.machineName}.
        </p>
        <div className="actions end">
          <button type="button" className="btn" onClick={props.close}>
            Close
          </button>
          <button
            type="button"
            className="btn primary"
            data-autofocus
            onClick={() =>
              portal.open({
                _tag: "newJoinCode",
                machineId: props.machineId,
                machineName: props.machineName,
              })
            }
          >
            New code
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Join code for ${props.machineName}`} onClose={props.close}>
      <div className="code-row">
        {codeCard}
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
      {props.tunnel?.status === "ready" && (
        <p className="small muted">
          Tunnel: <code>{props.tunnel.hostname}</code>. The machine starts it when it joins.
        </p>
      )}
      {props.tunnel?.status === "skipped" && (
        <p className="small error-text">{props.tunnel.reason}</p>
      )}
      <p className="small muted">
        It works once and expires {timeUntil(props.expiresAt, portal.now)}. On a machine that runs
        T3 already, use it in one of these ways:
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
      <p className="small muted">
        The machine shows as waiting on the map until it connects. This dialog tells you when it
        joins.
      </p>
      <div className="actions end">
        <button type="button" className="btn primary" onClick={props.close}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/**
 * MM-211: the one-step path. Each command installs the fork and joins with the code. A server
 * joins at once; the app joins when it starts.
 */
function InstallStep({ code }: { code: string }) {
  const [release, setRelease] = useState<ForkRelease | null>(null);
  const [copied, setCopied] = useState<InstallTarget | null>(null);
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
  const copy = (target: InstallTarget) =>
    navigator.clipboard.writeText(installCommand(target, code)).then(
      () => setCopied(target),
      () => setCopied(null),
    );
  return (
    <div className="install-step">
      <p className="small">
        <strong>Install and join in one step.</strong> Run the command of its system on the new
        machine. It installs T3 Code (Yarden-zamir's fork,{" "}
        <a href={release?.pageUrl ?? FORK_RELEASES_PAGE} target="_blank" rel="noreferrer">
          {release?.version ?? "fork releases"}
        </a>
        ) and joins with this code.
      </p>
      {INSTALL_TARGETS.map((target) => (
        <div key={target} className="install-row">
          <span className="install-os">{INSTALL_TARGET_LABEL[target]}</span>
          <code className="install-cmd">{installCommand(target, code)}</code>
          <button type="button" className="btn small" onClick={() => copy(target)}>
            <CopyIcon />
            {copied === target ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
      {(release?.macUrl || release?.windowsUrl) && (
        <p className="small muted">
          Or download the app: {release.macUrl && <a href={release.macUrl}>Mac (.dmg)</a>}
          {release.macUrl && release.windowsUrl && " · "}
          {release.windowsUrl && <a href={release.windowsUrl}>Windows (.exe)</a>}. Then paste the
          code in Settings &gt; Machines.
        </p>
      )}
    </div>
  );
}

function NewJoinCodeDialog(props: {
  machineId: MachineId;
  machineName: string;
  close: () => void;
}) {
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
              machineId: result.machineId,
              machineName: props.machineName,
              code: result.code,
              expiresAt: result.expiresAt,
              tunnel: result.tunnel,
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
/**
 * MM-913: an invite for a native app. Making it needs the passkey check of MM-1207, because the
 * app gets the access of its client. The QR holds the only copy of the code.
 */
function InviteAppDialog({ clientId, close }: { clientId?: ClientId; close: () => void }) {
  const portal = usePortalContext();
  const { map, now } = portal;
  const existing = clientId === undefined ? undefined : map.clients.find((c) => c.id === clientId);
  const [name, setName] = useState("");
  const [arrows, setArrows] = useState<Record<string, MachineLevel>>({});
  const [needsPasskey, setNeedsPasskey] = useState(false);
  const [invite, setInvite] = useState<InviteResponse | null>(null);
  const [status, setStatus] = useState<ApprovalsStatus | null>(null);
  const { pending, error, run } = useAction();

  // MM-1208: an invite needs the approvals app, so a fresh portal offers to set it up here too.
  useEffect(() => {
    let current = true;
    callApi<ApprovalsStatus>("GET", "/api/clients/approvals")
      .then((next) => current && setStatus(next))
      .catch(
        (reason: unknown) =>
          current &&
          setStatus({
            _tag: "missing",
            reason: reason instanceof Error ? reason.message : String(reason),
          }),
      );
    return () => {
      current = false;
    };
  }, []);

  const create = () =>
    run(async () => {
      const request: InviteRequest = existing
        ? { client: { _tag: "existing", clientId: existing.id }, arrows: [] }
        : {
            client: { _tag: "new", name: name.trim() },
            arrows: map.machines.flatMap((machine) => {
              const level = arrows[machine.id] ?? "none";
              return level === "none" ? [] : [{ to: machine.id, level }];
            }),
          };
      try {
        setInvite(await callApi<InviteResponse>("POST", "/api/grant/invite", request));
      } catch (reason) {
        if (reason instanceof StepUpNeeded) setNeedsPasskey(true);
        throw reason;
      }
    });

  return (
    <Modal
      title={existing ? `Invite an app into ${existing.name}` : "Invite an app"}
      onClose={close}
    >
      {invite ? (
        <div className="stack">
          <div className="qr-box">
            <QrCodeSvg value={invite.url} />
          </div>
          <p className="small">
            Scan this with the T3 app on the phone. It works once and expires{" "}
            {timeUntil(invite.expiresAt, now)}. Close this dialog when the phone joined.
          </p>
          <p className="small mono break">{invite.url}</p>
          <div className="actions end">
            <button
              type="button"
              className="btn"
              onClick={() => void navigator.clipboard.writeText(invite.url)}
            >
              <CopyIcon />
              Copy link
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() =>
                portal.call(async () => {
                  await callApi("POST", "/api/clients/invites/cancel", {
                    clientId: invite.clientId,
                  });
                  close();
                }, "The invite no longer works.")
              }
            >
              Cancel invite
            </button>
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <p className="small muted">
            The app gets its own token. Remove the client to end the token at once.
          </p>
          {status?._tag === "missing" && (
            <div className="row callout">
              <div className="v">{status.reason}</div>
              <button
                type="button"
                className="btn small"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    setStatus(await callApi<ApprovalsStatus>("POST", "/api/clients/approvals"));
                  })
                }
              >
                Set up approvals
              </button>
            </div>
          )}
          {!existing && (
            <>
              <label className="field">
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-autofocus
                  required
                  autoComplete="off"
                  placeholder="Pixel"
                />
              </label>
              {map.machines.map((machine) => (
                <label className="field inline" key={machine.id}>
                  {machine.name}
                  <select
                    value={arrows[machine.id] ?? "none"}
                    onChange={(e) => {
                      const level = LEVELS.find((l) => l === e.target.value) ?? "none";
                      setArrows({ ...arrows, [machine.id]: level });
                    }}
                  >
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {LEVEL_LABEL[level]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </>
          )}
          {existing?.serviceToken && (
            <p className="hint">
              The app token of {existing.name} ends when the new invite is used.
            </p>
          )}
          <ErrorLine error={error} />
          <div className="actions end">
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            {needsPasskey ? (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  location.href = `/api/grant/start?then=${encodeURIComponent(location.hash)}`;
                }}
              >
                Confirm with passkey
              </button>
            ) : (
              <button
                type="submit"
                className="btn primary"
                disabled={pending || status?._tag !== "ready"}
              >
                Create invite
              </button>
            )}
          </div>
          {needsPasskey && <p className="hint">After the passkey, open this invite again.</p>}
        </form>
      )}
    </Modal>
  );
}

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

/** MM-413: many shared values at once, for example from a saved settings file. */
function ImportSettingsDialog({ close }: { close: () => void }) {
  const portal = usePortalContext();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Modal title="Import shared values" onClose={close}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const result = importSharedChanges(portal.map, text);
          if (typeof result === "string") {
            setProblem(result);
            return;
          }
          if (result.length > 0) {
            portal.submit(`Imported ${result.length} shared values`, result);
          }
          close();
        }}
      >
        <p className="hint">
          Paste JSON in the form {'{ "server": { ... }, "client": { ... } }'}. Each key becomes a
          shared value, and every machine applies it.
        </p>
        <label className="field">
          Values
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setProblem(null);
            }}
            data-autofocus
            required
            spellCheck={false}
          />
        </label>
        {problem && <p className="error-text">{problem}</p>}
        <div className="actions end">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={text.trim() === ""}>
            Import
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
      label: "Import shared values",
      kind: "action",
      run: () => portal.open({ _tag: "importSettings" }),
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
    out.push({
      label: "Invite an app",
      kind: "action",
      run: () => portal.open({ _tag: "inviteApp" }),
    });
    // MM-904, MM-907: clients and the sign-ins that wait for approval.
    for (const client of map.clients) {
      out.push({
        label: client.name,
        kind: "client",
        run: () => portal.select({ _tag: "client", id: client.id }, "map"),
      });
    }
    for (const pending of portal.pending ?? []) {
      if (pending.state !== "pending") continue;
      out.push({
        label: `Approve ${pending.describedAs || "a browser"}`,
        kind: "client",
        run: () => portal.select({ _tag: "pending", thumbprint: pending.thumbprint }, "clients"),
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
