/**
 * MM-101: the one Durable Object that holds the whole map. It keeps the document, the history,
 * the queue, presence, proposals, join codes, resource history and alerts in SQLite, and the page and machine sockets with
 * the WebSocket Hibernation API. The rules live in `rules/`. This class stores, sends and calls
 * Cloudflare.
 */
import { DurableObject } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import {
  MACHINE_MAP_PROTOCOL,
  machineSessionSubject,
  MachineCommand,
  MachineId,
  MachineMapDocument,
  MachinePresence,
  MachineToPortal,
  MachineTunnelGrant,
  MapProposal,
  MapRevision,
  MapToolInputs,
  ScopedSettingValues,
  type CommandDelivery,
  type MachineCommandInput,
  type MachineRecord,
  type MapActor,
  type MapChange,
  type MapToolName,
  type PortalEvent,
  type PortalSnapshot,
  type PortalToMachine,
} from "@t3tools/contracts/machineMap";
import {
  HealthThresholds,
  MachineResourcesMessage,
  type HealthAlert,
  type HealthAlertKind,
  type PortalResourcesRequest,
  type ResourceRange,
  type ResourceSample,
  type ResourcesOverview,
} from "@t3tools/contracts/machineMapResources";

import type {
  AddMachineRequest,
  ChangesRequest,
  CommandRequest,
  DevicesResponse,
  EnrolledEvent,
  EnrollResponse,
  JoinCodeRequest,
  JoinCodeResponse,
  MapToolResult,
  PauseEvent,
  PauseResponse,
  PendingRotation,
  PortalSignIn,
  PushEndpointRequest,
  PushKeyResponse,
  PushMessage,
  PushSubscribeRequest,
  RemoveMachineResponse,
  ResumeResponse,
  RotationResponse,
  RotationsEvent,
  SampleResponse,
  TunnelSetup,
  SignOutEverywhereResponse,
  WriteResult,
  HealthEvent,
  ResourceSampleEvent,
} from "./api.ts";
import { PauseState } from "./api.ts";
import { configured, ownerEmails } from "./access.ts";
import { HEALTH_TABLES, HealthStore } from "./healthStore.ts";
import { sendPush, vapidKey, type PushTarget, type VapidKey } from "./push.ts";
import { CloudflareApi, tunnelTarget } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import {
  arrowChange,
  decideAgentWrite,
  gateTool,
  raisesAnyAccess,
  usesText,
} from "./rules/access.ts";
import {
  alertChanges,
  HOUR_MS,
  historyOf,
  MAX_SAMPLE_MESSAGE_BYTES,
  MINUTE_MS,
  minuteStart,
  offlineConditions,
  offlineDueAt,
  RANGE,
  RESOURCE_ALERT_KINDS,
  resourceConditions,
  thresholdsFor,
  type Conditions,
} from "./rules/health.ts";
import {
  applyChanges,
  checkEditableChanges,
  desiredState,
  emptyMap,
  findMachine,
  freePosition,
  hasJoined,
  machinesTouched,
  MapRuleError,
} from "./rules/map.ts";
import {
  applyPresetChanges,
  cutArrows,
  lockdownChanges,
  PAUSE_SUMMARY,
  PausedAccess,
  pausedAccess,
  restoreChanges,
  RESUME_SUMMARY,
  resumeChanges,
  savePresetChange,
} from "./rules/presets.ts";
import {
  addMinutes,
  canDeliver,
  DEFAULT_COMMAND_MINUTES,
  earliest,
  isDue,
  JOIN_CODE_MINUTES,
  localSettingChanges,
  PROPOSAL_MINUTES,
  ROTATION_MINUTES,
  supportsCommand,
} from "./rules/queue.ts";
import { newJoinCode, normalizeJoinCode, seal, sha256Hex, unseal } from "./sealedSecret.ts";

/** The owner behind an API call, as the Worker saw it. */
export interface OwnerContext {
  readonly email: string;
  readonly signInId: string;
  readonly device: string;
  readonly browser: string;
  readonly place: string;
}

/** The result of every RPC method. The Worker turns it into an HTTP response. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** An expected refusal with its HTTP status. */
class PortalError extends Error {
  override readonly name = "PortalError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Header from the Worker with the client id of a verified machine token. */
export const MACHINE_CLIENT_ID_HEADER = "X-Map-Machine-Client-Id";

const PAGE_TAG = "page";
const machineTag = (id: MachineId) => `machine:${id}`;

const Attachment = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("page") }),
  Schema.Struct({ kind: Schema.Literal("machine"), machineId: MachineId }),
]);
type Attachment = typeof Attachment.Type;

const decodeJson = <T>(schema: Schema.ConstraintDecoder<T>) => {
  const decode = Schema.decodeUnknownSync(schema);
  return (text: string): T => decode(JSON.parse(text));
};

const decodeMap = decodeJson(MachineMapDocument);
const decodeRevision = decodeJson(MapRevision);
const decodeCommand = decodeJson(MachineCommand);
const decodeProposal = decodeJson(MapProposal);
const decodePresence = decodeJson(MachinePresence);
const decodeSettings = decodeJson(ScopedSettingValues);
/** MM-1502: resource samples ride next to the base protocol. */
const MachineMessage = Schema.Union([MachineToPortal, MachineResourcesMessage]);
type MachineMessage = typeof MachineMessage.Type;
const decodeMachineMessage = decodeJson(MachineMessage);
const decodeThresholds = decodeJson(Schema.Record(Schema.String, HealthThresholds));
const decodeAttachment = Schema.decodeUnknownSync(Attachment);
const decodeTunnelGrant = decodeJson(MachineTunnelGrant);
const encodeTunnelGrant = (grant: MachineTunnelGrant): string => JSON.stringify(grant);

/** MM-713: the stored pause. Pages get `state` only. */
const PauseRecord = Schema.Struct({ state: PauseState, before: PausedAccess });
type PauseRecord = typeof PauseRecord.Type;
const decodePause = decodeJson(PauseRecord);
const decodeHelloProtocol = Schema.decodeUnknownOption(
  Schema.TaggedStruct("hello", { protocol: Schema.Number }),
);
/** The protocol of a `hello` message, or undefined for any other message. */
const decodeHelloVersion = (text: string): { protocol: number } | undefined => {
  try {
    const hello = decodeHelloProtocol(JSON.parse(text));
    return hello._tag === "Some" ? hello.value : undefined;
  } catch {
    return undefined;
  }
};

/** The shared input schemas of the agent tools (MM-801), compiled once. */
const decodeToolInput = {
  machines_read: Schema.decodeUnknownSync(MapToolInputs.machines_read),
  machines_set_access: Schema.decodeUnknownSync(MapToolInputs.machines_set_access),
  machines_set_setting: Schema.decodeUnknownSync(MapToolInputs.machines_set_setting),
  machines_command: Schema.decodeUnknownSync(MapToolInputs.machines_command),
  machines_queue_cancel: Schema.decodeUnknownSync(MapToolInputs.machines_queue_cancel),
  machines_undo: Schema.decodeUnknownSync(MapToolInputs.machines_undo),
  machines_preset: Schema.decodeUnknownSync(MapToolInputs.machines_preset),
  machines_resources: Schema.decodeUnknownSync(MapToolInputs.machines_resources),
};

const offline: MachinePresence = {
  online: false,
  lastSeenAt: null,
  appliedRevision: null,
  status: null,
};

/** MM-1204: at most this many enroll attempts per address in one window. */
const ENROLL_LIMIT = 10;
const ENROLL_WINDOW_MS = 15 * 60_000;
const SNAPSHOT_HISTORY = 100;
const SNAPSHOT_FINISHED_COMMANDS = 100;
/** A page records the same sign-in at most once a minute. */
const SIGN_IN_WRITE_MS = 60_000;
/** MM-709: an offline machine stops its agents if it connects within 7 days of the pause. */
const PAUSE_STOP_MINUTES = 7 * 24 * 60;
/** MM-1501: the portal asks a machine for a sample at most this often. */
const SAMPLE_REQUEST_GAP_MS = 10_000;
/** MM-1506: pages get the active alerts and this many ended ones. */
const PAGE_ENDED_ALERTS = 50;
/** MM-1503: the alarm prunes old resource points and alerts this often. */
const PRUNE_EVERY_MS = HOUR_MS;
/** MM-1808: the push words of each alert kind. */
const ALERT_PUSH: Record<HealthAlertKind, { readonly title: string; readonly unit: string }> = {
  cpu: { title: "CPU is high", unit: "%" },
  memory: { title: "memory is full", unit: "%" },
  disk: { title: "disk is full", unit: "%" },
  swap: { title: "swap traffic is high", unit: " MB/s" },
  offline: { title: "is down", unit: " minutes offline" },
};

const nowIso = () => new Date().toISOString();

const slug = (name: string): string => {
  let out = "";
  for (const char of name.toLowerCase()) {
    const keep = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
    if (keep) out += char;
    else if (!out.endsWith("-")) out += "-";
  }
  const trimmed = out
    .split("-")
    .filter((part) => part.length > 0)
    .join("-")
    .slice(0, 32);
  return trimmed.length > 0 ? trimmed : "machine";
};

/**
 * MM-213: the T3 server of a machine listens here, behind its tunnel. Limit: a desktop app that
 * finds 3773 busy picks the next port, and then the tunnel misses it. Revisit when a machine
 * reports its port in its status.
 */
const MACHINE_SERVICE = "http://127.0.0.1:3773";

/** MM-213: the tunnel of one machine. The flags say what "Add machine" made, so removal undoes only that. */
type MachineTunnelRow = {
  machine_id: string;
  tunnel_id: string;
  hostname: string;
  created_tunnel: number;
  dns_record_id: string | null;
  access_host_added: number;
};

type TunnelSetUpResult = {
  readonly row: Omit<MachineTunnelRow, "machine_id"> | null;
  readonly setup: TunnelSetup;
};

const skippedTunnel = (reason: string): TunnelSetup => ({ status: "skipped", reason });

const randomHex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const ownerActor = (owner: OwnerContext): MapActor => ({
  _tag: "owner",
  email: owner.email,
  device: `${owner.device} · ${owner.browser}`,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class MachineMapObject extends DurableObject<Env> {
  #map: MachineMapDocument;
  /** MM-711: null when nothing is paused. */
  #pause: PauseRecord | null;
  /** MM-1504: thresholds that differ from the defaults, by machine id. */
  #thresholds: Readonly<Record<string, HealthThresholds>>;
  /** MM-1501: when the portal last asked each machine for a sample. Lost on hibernation. */
  readonly #sampleRequests = new Map<MachineId, number>();
  readonly #health: HealthStore;
  /** MM-1807: read once from `VAPID_JWK`. */
  #vapid: Promise<VapidKey | null> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // MM-1001: liveness pings get their answer without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.#migrate();
    this.#health = new HealthStore({
      run: (query, ...bindings) => this.#sql(query, ...bindings),
      transaction: (work) => this.ctx.storage.transactionSync(work),
    });
    const row = this.#sql<{ value: string }>("SELECT value FROM meta WHERE key = 'map'")[0];
    this.#map = row ? decodeMap(row.value) : emptyMap();
    const pause = this.#sql<{ value: string }>("SELECT value FROM meta WHERE key = 'pause'")[0];
    this.#pause = pause ? decodePause(pause.value) : null;
    const thresholds = this.#sql<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'health_thresholds'",
    )[0];
    this.#thresholds = thresholds ? decodeThresholds(thresholds.value) : {};
  }

  // ---------------------------------------------------------------- storage

  #sql<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Array<SqlStorageValue>
  ): Array<T> {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  #migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (revision INTEGER PRIMARY KEY, data TEXT NOT NULL, map TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS commands_by_status ON commands (status, created_at);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS presence (machine_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reported_settings (machine_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS join_codes (code_hash TEXT PRIMARY KEY, machine_id TEXT NOT NULL, sealed_secret TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rotations (machine_id TEXT PRIMARY KEY, token_client_id TEXT NOT NULL, sealed_secret TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS machine_tokens (machine_id TEXT PRIMARY KEY, token_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS enroll_attempts (ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sign_ins (id TEXT PRIMARY KEY, device TEXT NOT NULL, browser TEXT NOT NULL, place TEXT NOT NULL, first_seen TEXT NOT NULL, last_used TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS machine_tunnels (machine_id TEXT PRIMARY KEY, tunnel_id TEXT NOT NULL, hostname TEXT NOT NULL, created_tunnel INTEGER NOT NULL, dns_record_id TEXT, access_host_added INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, sign_in_id TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    // MM-213: the sealed tunnel grant of a join code. Null for a code without a tunnel.
    const joinColumns = this.#sql<{ name: string }>("PRAGMA table_info(join_codes)");
    if (!joinColumns.some((column) => column.name === "sealed_tunnel")) {
      this.ctx.storage.sql.exec("ALTER TABLE join_codes ADD COLUMN sealed_tunnel TEXT");
    }
    this.ctx.storage.sql.exec(HEALTH_TABLES);
  }

  #revision(revision: number): MapRevision | undefined {
    const row = this.#sql<{ data: string }>(
      "SELECT data FROM revisions WHERE revision = ?",
      revision,
    )[0];
    return row ? decodeRevision(row.data) : undefined;
  }

  #history(before: number | null, limit: number): Array<MapRevision> {
    return this.#sql<{ data: string }>(
      "SELECT data FROM revisions WHERE revision < ? ORDER BY revision DESC LIMIT ?",
      before ?? Number.MAX_SAFE_INTEGER,
      limit,
    ).map((row) => decodeRevision(row.data));
  }

  #command(id: string): MachineCommand | undefined {
    const row = this.#sql<{ data: string }>("SELECT data FROM commands WHERE id = ?", id)[0];
    return row ? decodeCommand(row.data) : undefined;
  }

  #commandsWithStatus(status: MachineCommand["status"]): Array<MachineCommand> {
    return this.#sql<{ data: string }>(
      "SELECT data FROM commands WHERE status = ? ORDER BY created_at",
      status,
    ).map((row) => decodeCommand(row.data));
  }

  #saveCommand(command: MachineCommand): void {
    this.#sql(
      "INSERT OR REPLACE INTO commands (id, machine_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)",
      command.id,
      command.machineId,
      command.status,
      command.createdAt,
      JSON.stringify(command),
    );
    this.#broadcast({ _tag: "command", command });
  }

  #proposals(): Array<MapProposal> {
    return this.#sql<{ data: string }>("SELECT data FROM proposals").map((row) =>
      decodeProposal(row.data),
    );
  }

  #storedPresence(id: MachineId): MachinePresence {
    const row = this.#sql<{ data: string }>(
      "SELECT data FROM presence WHERE machine_id = ?",
      id,
    )[0];
    return row ? decodePresence(row.data) : offline;
  }

  /** MM-105: the last known state, with `online` from the open sockets. */
  #presence(id: MachineId, closing?: WebSocket): MachinePresence {
    const online = this.ctx
      .getWebSockets(machineTag(id))
      .some((ws) => ws !== closing && ws.readyState === WebSocket.OPEN);
    return { ...this.#storedPresence(id), online };
  }

  #savePresence(id: MachineId, presence: MachinePresence, closing?: WebSocket): void {
    this.#sql(
      "INSERT OR REPLACE INTO presence (machine_id, data) VALUES (?, ?)",
      id,
      JSON.stringify(presence),
    );
    this.#broadcast({ _tag: "presence", machineId: id, presence: this.#presence(id, closing) });
  }

  #reportedSettings(id: MachineId): ScopedSettingValues {
    const row = this.#sql<{ data: string }>(
      "SELECT data FROM reported_settings WHERE machine_id = ?",
      id,
    )[0];
    return row ? decodeSettings(row.data) : { server: {}, client: {} };
  }

  #saveReportedSettings(id: MachineId, settings: ScopedSettingValues): void {
    this.#sql(
      "INSERT OR REPLACE INTO reported_settings (machine_id, data) VALUES (?, ?)",
      id,
      JSON.stringify(settings),
    );
    this.#broadcast({ _tag: "reportedSettings", machineId: id, settings });
  }

  #pendingRotations(): Array<PendingRotation> {
    return this.#sql<{ machine_id: string; created_at: string; expires_at: string }>(
      "SELECT machine_id, created_at, expires_at FROM rotations ORDER BY created_at",
    ).map((row) => ({
      machineId: MachineId.make(row.machine_id),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  /**
   * MM-713: stores the pause, so it survives a restart, and shows it on every page.
   * MM-718: every connected machine gets the new `paused` flag, also when the pause made no revision.
   */
  #savePause(record: PauseRecord | null): void {
    if (record) {
      this.#sql(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('pause', ?)",
        JSON.stringify(record),
      );
    } else {
      this.#sql("DELETE FROM meta WHERE key = 'pause'");
    }
    this.#pause = record;
    this.#broadcast(this.#pauseEvent());
    for (const machine of this.#map.machines) this.#sendDesired(machine.id);
  }

  #pauseEvent(): PauseEvent {
    const pause = this.#pause;
    if (!pause) return { _tag: "pause", pause: null };
    return { _tag: "pause", pause: { ...pause.state, cut: cutArrows(this.#map, pause.before) } };
  }

  // ---------------------------------------------------------------- sockets

  #broadcast(
    event:
      | PortalEvent
      | RotationsEvent
      | PauseEvent
      | HealthEvent
      | ResourceSampleEvent
      | EnrolledEvent,
  ): void {
    const text = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets(PAGE_TAG)) {
      try {
        ws.send(text);
      } catch (error) {
        console.error("page send failed", errorMessage(error));
      }
    }
  }

  #sendTo(machineId: MachineId, message: PortalToMachine | PortalResourcesRequest): boolean {
    let sent = false;
    for (const ws of this.ctx.getWebSockets(machineTag(machineId))) {
      try {
        ws.send(JSON.stringify(message));
        sent = true;
      } catch (error) {
        console.error("machine send failed", machineId, errorMessage(error));
      }
    }
    return sent;
  }

  #sendDesired(machineId: MachineId): void {
    const state = desiredState(this.#map, machineId, this.#pause !== null);
    if (state) this.#sendTo(machineId, { _tag: "desired", state });
  }

  #snapshot(): PortalSnapshot {
    const finished = this.#sql<{ data: string }>(
      "SELECT data FROM commands WHERE status NOT IN ('queued', 'delivered') ORDER BY created_at DESC LIMIT ?",
      SNAPSHOT_FINISHED_COMMANDS,
    ).map((row) => decodeCommand(row.data));
    return {
      map: this.#map,
      presence: Object.fromEntries(this.#map.machines.map((m) => [m.id, this.#presence(m.id)])),
      reportedSettings: Object.fromEntries(
        this.#map.machines.map((m) => [m.id, this.#reportedSettings(m.id)]),
      ),
      commands: [
        ...this.#commandsWithStatus("queued"),
        ...this.#commandsWithStatus("delivered"),
        ...finished,
      ],
      history: this.#history(null, SNAPSHOT_HISTORY),
      proposals: this.#proposals(),
    };
  }

  /** WebSocket upgrades from the Worker: `/api/events` for pages, `/connect` for machines. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const { pathname } = new URL(request.url);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    if (pathname === "/api/events") {
      this.ctx.acceptWebSocket(server, [PAGE_TAG]);
      server.serializeAttachment({ kind: "page" } satisfies Attachment);
      // MM-106: a page gets the whole state first, then every change.
      server.send(
        JSON.stringify({ _tag: "snapshot", snapshot: this.#snapshot() } satisfies PortalEvent),
      );
      server.send(JSON.stringify(this.#rotationsEvent()));
      server.send(JSON.stringify(this.#pauseEvent()));
      server.send(JSON.stringify(this.#healthEvent()));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname === "/connect") {
      const clientId = request.headers.get(MACHINE_CLIENT_ID_HEADER);
      const machine = this.#map.machines.find((m) => m.tokenClientId === clientId);
      // MM-104, MM-208: an unknown or removed machine token never connects.
      if (!clientId || !machine) return new Response("Unknown machine token.", { status: 403 });
      for (const old of this.ctx.getWebSockets(machineTag(machine.id))) {
        old.close(4000, "Replaced by a new connection.");
      }
      this.ctx.acceptWebSocket(server, [machineTag(machine.id)]);
      server.serializeAttachment({ kind: "machine", machineId: machine.id } satisfies Attachment);
      this.#savePresence(machine.id, { ...this.#storedPresence(machine.id), lastSeenAt: nowIso() });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found.", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = decodeAttachment(ws.deserializeAttachment());
    // Pages only listen. Their pings get the automatic answer.
    if (attachment.kind !== "machine" || typeof message !== "string") return;
    const machine = findMachine(this.#map, attachment.machineId);
    if (!machine) {
      ws.close(4004, "This machine left the map.");
      return;
    }
    let parsed: MachineMessage;
    try {
      parsed = decodeMachineMessage(message);
    } catch (error) {
      // A machine on another protocol version learns why, instead of waiting for a desired state.
      const hello = decodeHelloVersion(message);
      if (hello !== undefined && hello.protocol !== MACHINE_MAP_PROTOCOL) {
        ws.close(4400, `The portal speaks protocol ${MACHINE_MAP_PROTOCOL}.`);
      }
      console.error("bad machine message", machine.id, errorMessage(error));
      return;
    }
    if (parsed._tag === "resources" && message.length > MAX_SAMPLE_MESSAGE_BYTES) {
      console.error("sample too big", machine.id, message.length);
      return;
    }
    await this.#onMachineMessage(machine, parsed);
    await this.#scheduleAlarm();
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = decodeAttachment(ws.deserializeAttachment());
    try {
      ws.close(code, reason);
    } catch {
      // The socket is already closed.
    }
    if (attachment.kind !== "machine" || !findMachine(this.#map, attachment.machineId)) return;
    const id = attachment.machineId;
    this.#savePresence(id, { ...this.#storedPresence(id), lastSeenAt: nowIso() }, ws);
    // MM-1505: the samples stop, so a resource alert would only show old news.
    this.#applyAlerts(id, {}, RESOURCE_ALERT_KINDS, Date.now());
    await this.#scheduleAlarm();
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("socket error", errorMessage(error));
    await this.webSocketClose(ws, 1011, "Socket error.");
  }

  // ---------------------------------------------------------------- machines

  async #onMachineMessage(machine: MachineRecord, message: MachineMessage): Promise<void> {
    const id = machine.id;
    switch (message._tag) {
      case "hello": {
        this.#savePresence(id, {
          online: true,
          lastSeenAt: nowIso(),
          appliedRevision: message.appliedRevision,
          status: message.status,
        });
        this.#saveReportedSettings(id, message.settings);
        this.#recordHostname(machine, message.status.hostname);
        this.#checkOffline(id, Date.now());
        // MM-603: the current desired state, not each queued revision.
        this.#sendDesired(id);
        await this.#sendRotation(id);
        this.#deliverCommands(id);
        return;
      }
      case "status": {
        this.#savePresence(id, {
          ...this.#storedPresence(id),
          lastSeenAt: nowIso(),
          status: message.status,
        });
        this.#recordHostname(machine, message.status.hostname);
        this.#deliverCommands(id);
        return;
      }
      case "applied": {
        this.#savePresence(id, {
          ...this.#storedPresence(id),
          lastSeenAt: nowIso(),
          appliedRevision: message.revision,
        });
        return;
      }
      case "localSettings": {
        const reported = this.#reportedSettings(id);
        this.#saveReportedSettings(id, {
          ...reported,
          [message.scope]: { ...reported[message.scope], ...message.values },
        });
        const changes = localSettingChanges(this.#map, id, message.scope, message.values);
        if (changes.length > 0) {
          this.#commit(
            { _tag: "agent", machineId: id, threadId: null, threadTitle: null },
            `changed on ${machine.name}`,
            changes,
          );
        }
        return;
      }
      case "commandResult": {
        const command = this.#command(message.commandId);
        if (!command || command.machineId !== id) return;
        if (command.status !== "queued" && command.status !== "delivered") return;
        this.#saveCommand({
          ...command,
          status: message.ok ? "succeeded" : "failed",
          updatedAt: nowIso(),
          result: message.result,
          error: message.error,
        });
        return;
      }
      case "toolCall": {
        const actor: MapActor = {
          _tag: "agent",
          machineId: id,
          threadId: message.threadId,
          threadTitle: message.threadTitle,
        };
        try {
          const result = this.#runTool(actor, message.tool, message.input);
          this.#sendTo(id, {
            _tag: "toolResult",
            requestId: message.requestId,
            ok: true,
            result,
            error: null,
          });
        } catch (error) {
          this.#sendTo(id, {
            _tag: "toolResult",
            requestId: message.requestId,
            ok: false,
            result: null,
            error: errorMessage(error),
          });
        }
        return;
      }
      case "resources": {
        this.#recordSample(id, message.sample);
        return;
      }
      case "rotated": {
        const row = this.#sql<{ token_client_id: string }>(
          "SELECT token_client_id FROM rotations WHERE machine_id = ?",
          id,
        )[0];
        if (!row || row.token_client_id !== message.tokenClientId) return;
        this.#sql("DELETE FROM rotations WHERE machine_id = ?", id);
        this.#broadcast(this.#rotationsEvent());
        // MM-207: the machine saved the new secret, so the old one stops now.
        const api = this.#cloudflare();
        const tokenId = api ? await this.#tokenId(api, machine) : null;
        if (api && tokenId) {
          await api.endPreviousSecret(tokenId).catch((error: unknown) => {
            console.error("could not end the previous secret", id, errorMessage(error));
          });
        }
        return;
      }
    }
  }

  /** MM-209: the machine reports its tunnel hostname. Peers use it to connect. */
  #recordHostname(machine: MachineRecord, hostname: string | null): void {
    if (hostname === null || hostname === machine.hostname) return;
    this.#commit(
      { _tag: "portal", reason: `${machine.name} reported its hostname` },
      `${machine.name} is at ${hostname}`,
      [{ _tag: "putMachine", machine: { ...machine, hostname } }],
    );
  }

  #deliverCommands(machineId: MachineId): void {
    const presence = this.#presence(machineId);
    for (const command of this.#commandsWithStatus("queued")) {
      if (command.machineId !== machineId || !canDeliver(command, presence)) continue;
      const delivered: MachineCommand = { ...command, status: "delivered", updatedAt: nowIso() };
      if (this.#sendTo(machineId, { _tag: "command", command: delivered }))
        this.#saveCommand(delivered);
    }
  }

  async #sendRotation(machineId: MachineId): Promise<boolean> {
    const row = this.#sql<{ token_client_id: string; sealed_secret: string }>(
      "SELECT token_client_id, sealed_secret FROM rotations WHERE machine_id = ?",
      machineId,
    )[0];
    if (!row) return false;
    const tokenSecret = await unseal(this.env.SECRET_KEY, row.sealed_secret);
    return this.#sendTo(machineId, {
      _tag: "rotate",
      tokenClientId: row.token_client_id,
      tokenSecret,
    });
  }

  #rotationsEvent(): RotationsEvent {
    return { _tag: "rotations", rotations: this.#pendingRotations() };
  }

  // ---------------------------------------------------------------- resources and health

  /**
   * MM-1503: the portal clock places the point, so a machine with a wrong clock cannot write into
   * the future.
   */
  #recordSample(machineId: MachineId, sample: ResourceSample): void {
    const nowMs = Date.now();
    this.#health.record(machineId, sample, nowMs);
    this.#broadcast({ _tag: "resourceSample", machineId, sample });
    this.#checkResources(machineId, nowMs);
  }

  #checkResources(machineId: MachineId, nowMs: number): void {
    const thresholds = thresholdsFor(this.#thresholds, machineId);
    const minutes = Math.max(thresholds.cpuMinutes, thresholds.swapMinutes);
    const points = this.#health.points(
      machineId,
      "minute",
      minuteStart(nowMs) - minutes * MINUTE_MS,
    );
    this.#applyAlerts(
      machineId,
      resourceConditions(points, thresholds),
      RESOURCE_ALERT_KINDS,
      nowMs,
    );
  }

  #checkOffline(machineId: MachineId, nowMs: number): void {
    const thresholds = thresholdsFor(this.#thresholds, machineId);
    this.#applyAlerts(
      machineId,
      offlineConditions(this.#presence(machineId), thresholds, nowMs),
      ["offline"],
      nowMs,
    );
  }

  #alerts(query: "active" | "page"): Array<HealthAlert> {
    return this.#health.alerts(query === "active" ? 0 : PAGE_ENDED_ALERTS);
  }

  /** MM-1505: starts and ends the alerts of the given kinds. Pages hear of every change. */
  #applyAlerts(
    machineId: MachineId,
    conditions: Conditions,
    kinds: ReadonlyArray<HealthAlertKind>,
    nowMs: number,
  ): void {
    const active = this.#alerts("active").filter((alert) => alert.machineId === machineId);
    const changes = alertChanges(active, conditions, kinds);
    if (changes.start.length === 0 && changes.end.length === 0) return;
    const at = new Date(nowMs).toISOString();
    for (const alert of changes.end) this.#health.saveAlert({ ...alert, endedAt: at });
    const name = findMachine(this.#map, machineId)?.name ?? machineId;
    for (const start of changes.start) {
      const words = ALERT_PUSH[start.kind];
      this.#notify({
        title: `${name} ${words.title}`,
        body: `${Math.round(start.value)}${words.unit}. The limit is ${start.threshold}${words.unit}.`,
        url: "/#/health",
        tag: `alert:${machineId}:${start.kind}`,
      });
      this.#health.saveAlert({
        id: crypto.randomUUID(),
        machineId,
        kind: start.kind,
        startedAt: at,
        endedAt: null,
        value: start.value,
        threshold: start.threshold,
      });
    }
    this.#broadcast(this.#healthEvent());
  }

  #overview(alerts: "active" | "page"): ResourcesOverview {
    const ids = new Set<string>(this.#map.machines.map((m) => m.id));
    const latest = this.#health.latest(ids);
    return { latest, alerts: this.#alerts(alerts), thresholds: this.#thresholds };
  }

  #healthEvent(): HealthEvent {
    return { _tag: "health", health: this.#overview("page") };
  }

  // ---------------------------------------------------------------- push

  #vapidKey(): Promise<VapidKey | null> {
    this.#vapid ??= vapidKey(this.env.VAPID_JWK);
    return this.#vapid;
  }

  #pushTargets(skipSignIn: string | null): Array<PushTarget> {
    return this.#sql<{ endpoint: string; p256dh: string; auth: string }>(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE sign_in_id IS NOT ?",
      skipSignIn,
    );
  }

  /**
   * MM-1807, MM-1808: sends one message to every subscribed device, with the badge count of
   * MM-1805. `skipSignIn` leaves out the device that caused it. A gone subscription is deleted.
   */
  #notify(message: Omit<PushMessage, "badge">, skipSignIn: string | null = null): void {
    const targets = this.#pushTargets(skipSignIn);
    if (targets.length === 0) return;
    const badge = this.#proposals().length + this.#alerts("active").length;
    this.ctx.waitUntil(this.#deliver(targets, { ...message, badge }));
  }

  async #deliver(targets: ReadonlyArray<PushTarget>, message: PushMessage): Promise<void> {
    const key = await this.#vapidKey().catch((error: unknown) => {
      console.error("VAPID_JWK is invalid", errorMessage(error));
      return null;
    });
    if (!key) return;
    const subject = `mailto:${ownerEmails(this.env)[0] ?? "owner@invalid"}`;
    await Promise.all(
      targets.map(async (target) => {
        try {
          if ((await sendPush(target, message, key, subject)) === "gone") {
            this.#sql("DELETE FROM push_subscriptions WHERE endpoint = ?", target.endpoint);
          }
        } catch (error) {
          console.error("push failed", errorMessage(error));
        }
      }),
    );
  }

  #resourceHistory(machineId: MachineId, range: ResourceRange) {
    const spec = RANGE[range];
    return historyOf(
      machineId,
      range,
      this.#health.points(machineId, spec.step, Date.now() - spec.spanMs),
    );
  }

  /** MM-1503, MM-1505: prunes resource points and ended alerts, and remembers when. */
  #pruneResources(nowMs: number): void {
    this.#health.prune(
      nowMs,
      this.#map.machines.map((m) => m.id),
    );
    this.#sql(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('resources_pruned_at', ?)",
      String(nowMs),
    );
  }

  #prunedAt(): number {
    const row = this.#sql<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'resources_pruned_at'",
    )[0];
    return row ? Number(row.value) : 0;
  }

  // ---------------------------------------------------------------- writes

  /**
   * MM-701: one revision. Pushes the new desired state to every touched online machine.
   * MM-711: while paused, only `resume` may raise an arrow or a map role.
   */
  #commit(
    actor: MapActor,
    summary: string,
    changes: ReadonlyArray<MapChange>,
    purpose: "change" | "pause" | "resume" = "change",
  ): MapRevision {
    if (changes.length === 0) throw new PortalError(409, "Nothing changes.");
    if (this.#pause && purpose !== "resume" && raisesAnyAccess(this.#map, changes)) {
      throw new PortalError(
        423,
        "Everything is paused. Resume first, then raise an arrow or a map role.",
      );
    }
    const applied = applyChanges(this.#map, changes);
    const map = { ...applied.map, revision: this.#map.revision + 1 };
    const revision: MapRevision = {
      revision: map.revision,
      at: nowIso(),
      actor,
      summary,
      changes,
      inverse: applied.inverse,
    };
    this.ctx.storage.transactionSync(() => {
      this.#sql(
        "INSERT INTO revisions (revision, data, map) VALUES (?, ?, ?)",
        revision.revision,
        JSON.stringify(revision),
        JSON.stringify(map),
      );
      this.#sql("INSERT OR REPLACE INTO meta (key, value) VALUES ('map', ?)", JSON.stringify(map));
    });
    this.#map = map;
    this.#broadcast({ _tag: "revision", revision, map });
    // MM-719: pause and resume push the desired state to every machine after the pause flag changes.
    if (purpose !== "change") return revision;
    const touched = machinesTouched(revision);
    for (const machine of map.machines) {
      if (touched === "all" || touched.has(machine.id)) this.#sendDesired(machine.id);
    }
    return revision;
  }

  #propose(
    actor: MapActor,
    summary: string,
    changes: ReadonlyArray<MapChange>,
    reason: MapProposal["reason"],
  ): MapProposal {
    const at = Date.now();
    const proposal: MapProposal = {
      id: crypto.randomUUID(),
      at: new Date(at).toISOString(),
      expiresAt: addMinutes(at, PROPOSAL_MINUTES),
      actor,
      summary,
      changes,
      reason,
    };
    this.#sql(
      "INSERT INTO proposals (id, data) VALUES (?, ?)",
      proposal.id,
      JSON.stringify(proposal),
    );
    this.#broadcast({ _tag: "proposals", proposals: this.#proposals() });
    const from =
      actor._tag === "agent" ? (findMachine(this.#map, actor.machineId)?.name ?? "an agent") : null;
    this.#notify({
      title: from ? `${from} proposes a change` : "A change waits in the Inbox",
      body: summary,
      url: `/#/inbox/proposal/${encodeURIComponent(proposal.id)}`,
      tag: `proposal:${proposal.id}`,
    });
    return proposal;
  }

  /** MM-802, MM-803: an agent change applies at once or becomes a proposal. */
  #agentWrite(
    actor: Extract<MapActor, { _tag: "agent" }>,
    summary: string,
    changes: ReadonlyArray<MapChange>,
  ): WriteResult {
    checkEditableChanges(this.#map, changes);
    const decision = decideAgentWrite(this.#map, actor.machineId, changes);
    if (decision._tag === "apply") {
      return { _tag: "applied", revision: this.#commit(actor, summary, changes).revision };
    }
    const proposal = this.#propose(actor, summary, changes, decision.reason);
    return { _tag: "proposed", proposalId: proposal.id, reason: decision.reason };
  }

  #createCommand(
    actor: MapActor,
    machineId: MachineId,
    input: MachineCommandInput,
    delivery: CommandDelivery,
    expiresInMinutes: number,
  ): MachineCommand {
    const machine = findMachine(this.#map, machineId);
    if (!machine) throw new PortalError(404, `Unknown machine ${machineId}.`);
    const status = this.#presence(machineId).status;
    if (!supportsCommand(status, input._tag)) {
      throw new PortalError(
        409,
        status === null
          ? `${machine.name} did not report its commands yet.`
          : `${machine.name} does not support ${input._tag}.`,
      );
    }
    if (input._tag === "testArrow" && !findMachine(this.#map, input.to)) {
      throw new PortalError(404, `Unknown machine ${input.to}.`);
    }
    return this.#queueCommand(actor, machineId, input, delivery, expiresInMinutes);
  }

  /** Queues a command without the checks of `#createCommand`, and delivers it when it can. */
  #queueCommand(
    actor: MapActor,
    machineId: MachineId,
    input: MachineCommandInput,
    delivery: CommandDelivery,
    expiresInMinutes: number,
  ): MachineCommand {
    const now = Date.now();
    const command: MachineCommand = {
      id: crypto.randomUUID(),
      machineId,
      input,
      delivery,
      actor,
      status: "queued",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: addMinutes(now, expiresInMinutes),
      result: null,
      error: null,
    };
    this.#saveCommand(command);
    this.#deliverCommands(machineId);
    return this.#command(command.id) ?? command;
  }

  #cancelCommand(commandId: string): MachineCommand {
    const command = this.#command(commandId);
    if (!command) throw new PortalError(404, "Unknown command.");
    if (command.status !== "queued") {
      throw new PortalError(
        409,
        `The command is ${command.status}. Only a queued command can be cancelled.`,
      );
    }
    const cancelled: MachineCommand = { ...command, status: "cancelled", updatedAt: nowIso() };
    this.#saveCommand(cancelled);
    return cancelled;
  }

  /** MM-703. Revisions that add or remove a machine cannot be undone (see checkEditableChanges). */
  #undoChanges(revisionNumber: number): { summary: string; changes: ReadonlyArray<MapChange> } {
    const revision = this.#revision(revisionNumber);
    if (!revision) throw new PortalError(404, `Unknown revision ${revisionNumber}.`);
    checkEditableChanges(this.#map, revision.inverse);
    return {
      summary: `Undo rev ${revision.revision}: ${revision.summary}`,
      changes: revision.inverse,
    };
  }

  #presetChanges(
    action: "save" | "apply",
    name: string,
  ): { summary: string; changes: ReadonlyArray<MapChange> } {
    if (action === "save") {
      return {
        summary: `Saved preset ${name}`,
        changes: [savePresetChange(this.#map, name, nowIso())],
      };
    }
    const preset = this.#map.presets.find((p) => p.name === name);
    if (!preset) throw new PortalError(404, `Unknown preset ${name}.`);
    const changes = applyPresetChanges(this.#map, preset);
    if (changes.length === 0) throw new PortalError(409, `The arrows already match ${name}.`);
    return { summary: `Applied preset ${name}`, changes };
  }

  /** MM-801, MM-805: one agent tool call, with the map role check of the calling machine. */
  #runTool(
    actor: Extract<MapActor, { _tag: "agent" }>,
    tool: MapToolName,
    input: unknown,
  ): MapToolResult {
    // MM-711: no agent uses the map while everything is paused, not even to read it.
    if (this.#pause) {
      throw new PortalError(
        423,
        `Everything is paused since ${this.#pause.state.pausedAt}. The owner pressed the emergency pause. Only the owner can resume, in the portal.`,
      );
    }
    const gate = gateTool(this.#map, actor.machineId, tool);
    if (gate._tag === "refuse") throw new PortalError(403, gate.error);
    const name = (id: MachineId) => findMachine(this.#map, id)?.name ?? id;
    switch (tool) {
      case "machines_read": {
        decodeToolInput.machines_read(input);
        const snapshot = this.#snapshot();
        return {
          _tag: "read",
          map: snapshot.map,
          presence: snapshot.presence,
          commands: snapshot.commands,
          history: this.#history(null, 50),
          proposals: snapshot.proposals,
          resources: this.#overview("active"),
        };
      }
      case "machines_resources": {
        const args = decodeToolInput.machines_resources(input);
        if (!findMachine(this.#map, args.machineId)) {
          throw new PortalError(404, `Unknown machine ${args.machineId}.`);
        }
        const range = args.range ?? "hour";
        const since = new Date(Date.now() - RANGE[range].spanMs).toISOString();
        return {
          _tag: "resources",
          history: this.#resourceHistory(args.machineId, range),
          alerts: this.#health.alertsOf(args.machineId, since),
        };
      }
      case "machines_set_access": {
        const args = decodeToolInput.machines_set_access(input);
        const change = arrowChange(this.#map, {
          from: args.from,
          to: args.to,
          level: args.level,
          ...(args.agentTools === undefined ? {} : { agentTools: args.agentTools }),
          expiresAt:
            args.expiresInMinutes === undefined
              ? null
              : addMinutes(Date.now(), args.expiresInMinutes),
        });
        return this.#agentWrite(
          actor,
          `${usesText(name(args.from), name(args.to))}: ${args.level}`,
          [change],
        );
      }
      case "machines_set_setting": {
        const args = decodeToolInput.machines_set_setting(input);
        const present = args.clear !== true && Object.hasOwn(args, "value");
        const target = args.machineId === undefined ? "shared" : name(args.machineId);
        return this.#agentWrite(
          actor,
          present
            ? `${args.scope}.${args.key} set on ${target}`
            : `${args.scope}.${args.key} cleared on ${target}`,
          [
            {
              _tag: "setSetting",
              machineId: args.machineId ?? null,
              scope: args.scope,
              key: args.key,
              present,
              value: present ? args.value : null,
            },
          ],
        );
      }
      case "machines_command": {
        const args = decodeToolInput.machines_command(input);
        const command = this.#createCommand(
          actor,
          args.machineId,
          args.command,
          args.delivery ?? "online",
          args.expiresInMinutes ?? DEFAULT_COMMAND_MINUTES,
        );
        return { _tag: "command", command };
      }
      case "machines_queue_cancel": {
        const args = decodeToolInput.machines_queue_cancel(input);
        return { _tag: "command", command: this.#cancelCommand(args.commandId) };
      }
      case "machines_undo": {
        const args = decodeToolInput.machines_undo(input);
        const undo = this.#undoChanges(args.revision);
        return this.#agentWrite(actor, undo.summary, undo.changes);
      }
      case "machines_preset": {
        const args = decodeToolInput.machines_preset(input);
        const preset = this.#presetChanges(args.action, args.name);
        return this.#agentWrite(actor, preset.summary, preset.changes);
      }
    }
  }

  // ---------------------------------------------------------------- Cloudflare

  /** MM-1205: null when the Worker has no Cloudflare API token. */
  #cloudflare(): CloudflareApi | null {
    return this.env.CF_API_TOKEN
      ? new CloudflareApi(this.env.CF_API_TOKEN, this.env.ACCOUNT_ID)
      : null;
  }

  async #tokenId(api: CloudflareApi, machine: MachineRecord): Promise<string | null> {
    const row = this.#sql<{ token_id: string }>(
      "SELECT token_id FROM machine_tokens WHERE machine_id = ?",
      machine.id,
    )[0];
    if (row) return row.token_id;
    const found = await api.findServiceTokenId(machine.tokenClientId);
    if (found) {
      this.#sql(
        "INSERT OR REPLACE INTO machine_tokens (machine_id, token_id) VALUES (?, ?)",
        machine.id,
        found,
      );
    }
    return found;
  }

  #accessAppIds(): Array<string> {
    const ids = [this.env.MACHINE_ACCESS_APP_ID, this.env.CONNECT_ACCESS_APP_ID];
    if (!ids.every(configured)) {
      throw new PortalError(
        503,
        "Set MACHINE_ACCESS_APP_ID and CONNECT_ACCESS_APP_ID in wrangler.jsonc first.",
      );
    }
    return ids;
  }

  /** MM-1201: the secret and the tunnel grant wait for the machine encrypted. */
  async #issueJoinCode(
    machineId: MachineId,
    secret: string,
    tunnel: { readonly grant: MachineTunnelGrant | null; readonly setup: TunnelSetup | null },
  ): Promise<JoinCodeResponse> {
    const code = newJoinCode();
    const codeHash = await sha256Hex(normalizeJoinCode(code));
    const sealed = await seal(this.env.SECRET_KEY, secret);
    const sealedTunnel =
      tunnel.grant === null
        ? null
        : await seal(this.env.SECRET_KEY, encodeTunnelGrant(tunnel.grant));
    const expiresAt = addMinutes(Date.now(), JOIN_CODE_MINUTES);
    this.ctx.storage.transactionSync(() => {
      this.#sql("DELETE FROM join_codes WHERE machine_id = ?", machineId);
      this.#sql(
        "INSERT INTO join_codes (code_hash, machine_id, sealed_secret, expires_at, sealed_tunnel) VALUES (?, ?, ?, ?, ?)",
        codeHash,
        machineId,
        sealed,
        expiresAt,
        sealedTunnel,
      );
    });
    return { machineId, code, expiresAt, tunnel: tunnel.setup };
  }

  // ---------------------------------------------------------------- MM-213: machine tunnels

  #tunnelRow(machineId: MachineId): MachineTunnelRow | undefined {
    return this.#sql<MachineTunnelRow>(
      "SELECT * FROM machine_tunnels WHERE machine_id = ?",
      machineId,
    )[0];
  }

  /**
   * Makes or reuses the tunnel `t3-<slug>`, its ingress, its DNS name and its place in the
   * machine Access app. A failure undoes what this call made and skips the tunnel, so "Add
   * machine" still works as before MM-213.
   */
  async #setUpTunnel(api: CloudflareApi, machineName: string): Promise<TunnelSetUpResult> {
    const domain = this.env.MACHINE_DOMAIN;
    const zoneId = this.env.MACHINE_ZONE_ID;
    if (!configured(domain) || !configured(zoneId)) {
      return {
        row: null,
        setup: skippedTunnel(
          "Set MACHINE_DOMAIN and MACHINE_ZONE_ID in wrangler.jsonc for tunnels.",
        ),
      };
    }
    const name = `t3-${slug(machineName)}`;
    const hostname = `${name}.${domain}`;
    const made = {
      tunnelId: null as string | null,
      dnsRecordId: null as string | null,
      hostAdded: false,
    };
    try {
      const record = await api.findDnsRecord(zoneId, hostname);
      let tunnel;
      if (record) {
        // Reuse the tunnel that the name points at. Any other record belongs to something else.
        const suffix = tunnelTarget("");
        const tunnelId =
          record.type === "CNAME" && record.content.endsWith(suffix)
            ? record.content.slice(0, -suffix.length)
            : null;
        tunnel = tunnelId === null ? null : await api.findTunnelById(tunnelId);
        if (!tunnel) {
          return {
            row: null,
            setup: skippedTunnel(
              `${hostname} points at something else. Set up its tunnel by hand.`,
            ),
          };
        }
      } else {
        tunnel = await api.findTunnelByName(name);
        if (!tunnel) {
          tunnel = await api.createTunnel(name);
          made.tunnelId = tunnel.id;
        }
      }
      if (tunnel.config_src !== "cloudflare") {
        return {
          row: null,
          setup: skippedTunnel(
            `The tunnel ${name} is managed on its machine. The machine keeps it.`,
          ),
        };
      }
      await api.ensureIngress(tunnel.id, hostname, MACHINE_SERVICE);
      if (!record) made.dnsRecordId = (await api.createTunnelCname(zoneId, hostname, tunnel.id)).id;
      made.hostAdded = await api.addAppHostname(this.env.MACHINE_ACCESS_APP_ID, hostname);
      return {
        row: {
          tunnel_id: tunnel.id,
          hostname,
          created_tunnel: made.tunnelId === null ? 0 : 1,
          dns_record_id: made.dnsRecordId,
          access_host_added: made.hostAdded ? 1 : 0,
        },
        setup: { status: "ready", hostname },
      };
    } catch (error) {
      const message = errorMessage(error);
      console.error("machine tunnel setup failed", hostname, message);
      await this.#tearDownTunnel(api, {
        tunnel_id: made.tunnelId ?? "",
        hostname,
        created_tunnel: made.tunnelId === null ? 0 : 1,
        dns_record_id: made.dnsRecordId,
        access_host_added: made.hostAdded ? 1 : 0,
      });
      return {
        row: null,
        setup: skippedTunnel(
          `No tunnel: ${message}. The Cloudflare API token needs "Cloudflare Tunnel: Edit" and "DNS: Edit". Set up the tunnel by hand.`,
        ),
      };
    }
  }

  /**
   * Deletes only what `#setUpTunnel` made. Each step logs its failure and the next step runs.
   * Limit: an ingress rule added to a reused tunnel stays. Revisit when reused tunnels are common.
   */
  async #tearDownTunnel(
    api: CloudflareApi,
    row: Omit<MachineTunnelRow, "machine_id">,
  ): Promise<void> {
    const step = (what: string, run: () => Promise<unknown>) =>
      run().catch((error: unknown) => {
        console.error(`could not ${what}`, row.hostname, errorMessage(error));
      });
    if (row.access_host_added === 1) {
      await step("remove the Access hostname", () =>
        api.removeAppHostname(this.env.MACHINE_ACCESS_APP_ID, row.hostname),
      );
    }
    const zoneId = this.env.MACHINE_ZONE_ID;
    if (row.dns_record_id !== null && configured(zoneId)) {
      const recordId = row.dns_record_id;
      await step("delete the DNS record", () => api.deleteDnsRecord(zoneId, recordId));
    }
    if (row.created_tunnel === 1) {
      await step("delete the tunnel", () => api.deleteTunnel(row.tunnel_id));
    }
  }

  /** The tunnel token and the Access login of a machine. It holds a secret: never log it. */
  async #tunnelGrant(api: CloudflareApi, row: MachineTunnelRow): Promise<MachineTunnelGrant> {
    const [token, aud] = await Promise.all([
      api.tunnelToken(row.tunnel_id),
      api.accessAppAud(this.env.MACHINE_ACCESS_APP_ID),
    ]);
    const [first, ...rest] = [
      ...ownerEmails(this.env),
      ...(this.env.MACHINE_ACCESS_SUBJECTS ?? "")
        .split(",")
        .map((subject) => subject.trim())
        .filter((subject) => subject.length > 0),
    ];
    if (first === undefined)
      throw new PortalError(503, "Set OWNER_EMAILS in wrangler.jsonc first.");
    return {
      hostname: row.hostname,
      token,
      access: { teamDomain: this.env.TEAM_DOMAIN, aud, subjects: [first, ...rest] },
    };
  }

  // ---------------------------------------------------------------- alarms

  async #scheduleAlarm(): Promise<void> {
    const times = [
      ...this.#map.arrows.flatMap((arrow) => (arrow.expiresAt ? [arrow.expiresAt] : [])),
      ...this.#commandsWithStatus("queued").map((command) => command.expiresAt),
      ...this.#proposals().map((proposal) => proposal.expiresAt),
      ...this.#sql<{ expires_at: string }>("SELECT expires_at FROM join_codes").map(
        (r) => r.expires_at,
      ),
      ...this.#sql<{ expires_at: string }>("SELECT expires_at FROM rotations").map(
        (r) => r.expires_at,
      ),
      ...this.#healthAlarmTimes(),
    ];
    const at = earliest(times);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  /** MM-1504: when an offline machine counts as down, and MM-1503: the next prune. */
  #healthAlarmTimes(): Array<string> {
    const downAlready = new Set<string>(
      this.#alerts("active").flatMap((alert) =>
        alert.kind === "offline" ? [alert.machineId] : [],
      ),
    );
    const times = this.#map.machines.flatMap((machine) => {
      if (downAlready.has(machine.id)) return [];
      const due = offlineDueAt(
        this.#presence(machine.id),
        thresholdsFor(this.#thresholds, machine.id),
      );
      return due === null ? [] : [new Date(due).toISOString()];
    });
    if (this.#health.hasPoints())
      times.push(new Date(this.#prunedAt() + PRUNE_EVERY_MS).toISOString());
    return times;
  }

  /**
   * Arrow, command, proposal, join code and rotation expiry (MM-304, MM-605, MM-804, MM-202,
   * MM-1201), offline alerts (MM-1504) and the resource prune (MM-1503).
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const arrow of this.#map.arrows) {
      if (arrow.expiresAt === null || arrow.revertLevel === null || !isDue(arrow.expiresAt, now))
        continue;
      const from = findMachine(this.#map, arrow.from)?.name ?? arrow.from;
      const to = findMachine(this.#map, arrow.to)?.name ?? arrow.to;
      this.#commit(
        { _tag: "portal", reason: "expiry" },
        `${usesText(from, to)}: back to ${arrow.revertLevel}`,
        [
          {
            _tag: "setArrow",
            arrow: { ...arrow, level: arrow.revertLevel, expiresAt: null, revertLevel: null },
          },
        ],
      );
    }
    for (const command of this.#commandsWithStatus("queued")) {
      if (!isDue(command.expiresAt, now)) continue;
      this.#saveCommand({
        ...command,
        status: "expired",
        updatedAt: new Date(now).toISOString(),
        error: "Expired before the machine could take it.",
      });
    }
    const expiredProposals = this.#proposals().filter((p) => isDue(p.expiresAt, now));
    for (const proposal of expiredProposals)
      this.#sql("DELETE FROM proposals WHERE id = ?", proposal.id);
    if (expiredProposals.length > 0)
      this.#broadcast({ _tag: "proposals", proposals: this.#proposals() });

    for (const row of this.#sql<{ code_hash: string; expires_at: string }>(
      "SELECT code_hash, expires_at FROM join_codes",
    )) {
      if (isDue(row.expires_at, now))
        this.#sql("DELETE FROM join_codes WHERE code_hash = ?", row.code_hash);
    }
    let rotationsChanged = false;
    for (const row of this.#sql<{ machine_id: string; expires_at: string }>(
      "SELECT machine_id, expires_at FROM rotations",
    )) {
      if (!isDue(row.expires_at, now)) continue;
      this.#sql("DELETE FROM rotations WHERE machine_id = ?", row.machine_id);
      rotationsChanged = true;
    }
    if (rotationsChanged) this.#broadcast(this.#rotationsEvent());
    this.#sql("DELETE FROM enroll_attempts WHERE window_start < ?", now - ENROLL_WINDOW_MS);
    for (const machine of this.#map.machines) this.#checkOffline(machine.id, now);
    if (now >= this.#prunedAt() + PRUNE_EVERY_MS) this.#pruneResources(now);
    await this.#scheduleAlarm();
  }

  // ---------------------------------------------------------------- RPC

  async #run<T>(owner: OwnerContext | null, work: () => T | Promise<T>): Promise<Outcome<T>> {
    if (owner) this.#recordSignIn(owner);
    try {
      const value = await work();
      await this.#scheduleAlarm();
      return { ok: true, value };
    } catch (error) {
      if (error instanceof PortalError)
        return { ok: false, status: error.status, error: error.message };
      if (error instanceof MapRuleError) return { ok: false, status: 409, error: error.message };
      throw error;
    }
  }

  /** MM-901: the portal remembers each browser of the owner. */
  #recordSignIn(owner: OwnerContext): void {
    const now = Date.now();
    const row = this.#sql<{ last_used: string }>(
      "SELECT last_used FROM sign_ins WHERE id = ?",
      owner.signInId,
    )[0];
    if (row && now - Date.parse(row.last_used) < SIGN_IN_WRITE_MS) return;
    const at = new Date(now).toISOString();
    this.#sql(
      `INSERT INTO sign_ins (id, device, browser, place, first_seen, last_used) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET place = excluded.place, last_used = excluded.last_used`,
      owner.signInId,
      owner.device,
      owner.browser,
      owner.place,
      at,
      at,
    );
  }

  snapshot(owner: OwnerContext) {
    return this.#run(owner, () => this.#snapshot());
  }

  /** POST /api/changes: owner changes apply at once (MM-701). */
  changes(owner: OwnerContext, request: ChangesRequest) {
    return this.#run(owner, (): WriteResult => {
      checkEditableChanges(this.#map, request.changes);
      return {
        _tag: "applied",
        revision: this.#commit(ownerActor(owner), request.summary, request.changes).revision,
      };
    });
  }

  createCommand(owner: OwnerContext, request: CommandRequest) {
    return this.#run(owner, () =>
      this.#createCommand(
        ownerActor(owner),
        request.machineId,
        request.input,
        request.delivery,
        request.expiresInMinutes,
      ),
    );
  }

  cancelCommand(owner: OwnerContext, commandId: string) {
    return this.#run(owner, () => this.#cancelCommand(commandId));
  }

  undo(owner: OwnerContext, revision: number) {
    return this.#run(owner, (): WriteResult => {
      const undo = this.#undoChanges(revision);
      return {
        _tag: "applied",
        revision: this.#commit(ownerActor(owner), undo.summary, undo.changes).revision,
      };
    });
  }

  /** MM-704: a new revision that returns the map to an older revision. */
  restore(owner: OwnerContext, revision: number) {
    return this.#run(owner, (): WriteResult => {
      const target = this.#mapAt(revision);
      const changes = restoreChanges(this.#map, target);
      if (changes.length === 0)
        throw new PortalError(409, `The map already matches rev ${revision}.`);
      return {
        _tag: "applied",
        revision: this.#commit(ownerActor(owner), `Restore rev ${revision}`, changes).revision,
      };
    });
  }

  history(owner: OwnerContext, before: number | null, limit: number) {
    return this.#run(owner, () => ({
      revisions: this.#history(before, Math.min(Math.max(limit, 1), 500)),
    }));
  }

  #mapAt(revision: number): MachineMapDocument {
    if (revision === 0) return emptyMap();
    const row = this.#sql<{ map: string }>(
      "SELECT map FROM revisions WHERE revision = ?",
      revision,
    )[0];
    if (!row) throw new PortalError(404, `Unknown revision ${revision}.`);
    return decodeMap(row.map);
  }

  mapAt(owner: OwnerContext, revision: number) {
    return this.#run(owner, () => ({ map: this.#mapAt(revision) }));
  }

  /** MM-804: an approved proposal applies as a revision of its agent. */
  approveProposal(owner: OwnerContext, id: string) {
    return this.#run(owner, (): WriteResult => {
      const proposal = this.#proposals().find((p) => p.id === id);
      if (!proposal) throw new PortalError(404, "Unknown or expired proposal.");
      checkEditableChanges(this.#map, proposal.changes);
      const revision = this.#commit(
        proposal.actor,
        `${proposal.summary} (approved by ${owner.email})`,
        proposal.changes,
      );
      this.#sql("DELETE FROM proposals WHERE id = ?", id);
      this.#broadcast({ _tag: "proposals", proposals: this.#proposals() });
      return { _tag: "applied", revision: revision.revision };
    });
  }

  rejectProposal(owner: OwnerContext, id: string) {
    return this.#run(owner, () => {
      const removed = this.#sql<{ id: string }>(
        "DELETE FROM proposals WHERE id = ? RETURNING id",
        id,
      );
      if (removed.length === 0) throw new PortalError(404, "Unknown or expired proposal.");
      this.#broadcast({ _tag: "proposals", proposals: this.#proposals() });
      return { rejected: id };
    });
  }

  /** MM-201, MM-202, MM-210. */
  addMachine(owner: OwnerContext, request: AddMachineRequest) {
    return this.#run(owner, async (): Promise<JoinCodeResponse> => {
      if (!this.env.SECRET_KEY) throw new PortalError(503, "Set the SECRET_KEY secret first.");
      const existing =
        request.tokenClientId !== undefined && request.tokenSecret !== undefined
          ? { clientId: request.tokenClientId, secret: request.tokenSecret }
          : null;
      if (!existing && (request.tokenClientId !== undefined || request.tokenSecret !== undefined)) {
        throw new PortalError(400, "Give both the client id and the secret of the machine token.");
      }
      if (this.#map.machines.some((m) => m.name.toLowerCase() === request.name.toLowerCase())) {
        throw new PortalError(409, `A machine named ${request.name} is already on the map.`);
      }
      const api = this.#cloudflare();
      let token: { clientId: string; secret: string; id: string | null };
      let tunnel: TunnelSetUpResult | null = null;
      if (existing) {
        if (this.#map.machines.some((m) => m.tokenClientId === existing.clientId)) {
          throw new PortalError(409, "Another machine already uses this machine token.");
        }
        token = { ...existing, id: null };
      } else if (api) {
        const appIds = this.#accessAppIds();
        const created = await api.createServiceToken(`t3-machine-${slug(request.name)}`);
        try {
          for (const appId of appIds) await api.addTokenToApp(appId, created.id);
        } catch (error) {
          await api.deleteServiceToken(created.id).catch(() => undefined);
          throw error;
        }
        token = { clientId: created.client_id, secret: created.client_secret, id: created.id };
        tunnel = await this.#setUpTunnel(api, request.name);
      } else {
        throw new PortalError(
          400,
          "The portal has no Cloudflare API token. Give the client id and secret of an existing machine token.",
        );
      }
      const machine: MachineRecord = {
        id: MachineId.make(`${slug(request.name)}-${randomHex(2)}`),
        name: request.name,
        kind: request.kind,
        tokenClientId: token.clientId,
        hostname: null,
        position: request.position ?? freePosition(this.#map.machines.map((m) => m.position)),
        mapRole: "none",
        createdAt: nowIso(),
      };
      this.#commit(ownerActor(owner), `Added ${machine.name}`, [{ _tag: "putMachine", machine }]);
      if (token.id) {
        this.#sql(
          "INSERT OR REPLACE INTO machine_tokens (machine_id, token_id) VALUES (?, ?)",
          machine.id,
          token.id,
        );
      }
      const tunnelRow = tunnel?.row ? { machine_id: machine.id, ...tunnel.row } : null;
      if (tunnelRow) {
        this.#sql(
          "INSERT OR REPLACE INTO machine_tunnels (machine_id, tunnel_id, hostname, created_tunnel, dns_record_id, access_host_added) VALUES (?, ?, ?, ?, ?, ?)",
          tunnelRow.machine_id,
          tunnelRow.tunnel_id,
          tunnelRow.hostname,
          tunnelRow.created_tunnel,
          tunnelRow.dns_record_id,
          tunnelRow.access_host_added,
        );
      }
      // A grant that fails now still leaves the tunnel for a new join code.
      const grant =
        api && tunnelRow
          ? await this.#tunnelGrant(api, tunnelRow).catch((error: unknown) => {
              console.error("could not read the tunnel grant", machine.id, errorMessage(error));
              return null;
            })
          : null;
      const setup =
        tunnel === null
          ? null
          : tunnelRow && grant === null
            ? skippedTunnel(
                "The tunnel exists, but its token could not be read. Make a new join code.",
              )
            : tunnel.setup;
      return this.#issueJoinCode(machine.id, token.secret, { grant, setup });
    });
  }

  /**
   * A new join code for a machine. With a given secret, the code delivers it. Otherwise the portal
   * rotates the token, and the old secret stops at once.
   */
  newJoinCode(owner: OwnerContext, machineId: MachineId, request: JoinCodeRequest) {
    return this.#run(owner, async (): Promise<JoinCodeResponse> => {
      if (!this.env.SECRET_KEY) throw new PortalError(503, "Set the SECRET_KEY secret first.");
      const machine = findMachine(this.#map, machineId);
      if (!machine) throw new PortalError(404, `Unknown machine ${machineId}.`);
      const api = this.#cloudflare();
      const tunnelRow = this.#tunnelRow(machine.id);
      const tunnel =
        api && tunnelRow
          ? {
              grant: await this.#tunnelGrant(api, tunnelRow),
              setup: { status: "ready", hostname: tunnelRow.hostname } as const,
            }
          : { grant: null, setup: null };
      if (request.tokenSecret !== undefined)
        return this.#issueJoinCode(machine.id, request.tokenSecret, tunnel);
      if (!api)
        throw new PortalError(
          400,
          "The portal has no Cloudflare API token. Give the token secret.",
        );
      const tokenId = await this.#tokenId(api, machine);
      if (!tokenId)
        throw new PortalError(409, "Cloudflare has no service token with this client id.");
      const secret = await api.rotateServiceToken(tokenId, nowIso());
      return this.#issueJoinCode(machine.id, secret, tunnel);
    });
  }

  /**
   * MM-207. The old secret works until the machine confirms the new one, or until the rotation
   * expires. A machine that stays offline past the expiry needs a new join code.
   */
  rotateToken(owner: OwnerContext, machineId: MachineId) {
    return this.#run(owner, async (): Promise<RotationResponse> => {
      if (!this.env.SECRET_KEY) throw new PortalError(503, "Set the SECRET_KEY secret first.");
      const machine = findMachine(this.#map, machineId);
      if (!machine) throw new PortalError(404, `Unknown machine ${machineId}.`);
      const api = this.#cloudflare();
      if (!api) throw new PortalError(400, "Token rotation needs the CF_API_TOKEN secret.");
      const tokenId = await this.#tokenId(api, machine);
      if (!tokenId)
        throw new PortalError(409, "Cloudflare has no service token with this client id.");
      const now = Date.now();
      const expiresAt = addMinutes(now, ROTATION_MINUTES);
      const secret = await api.rotateServiceToken(tokenId, expiresAt);
      this.#sql(
        "INSERT OR REPLACE INTO rotations (machine_id, token_client_id, sealed_secret, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        machine.id,
        machine.tokenClientId,
        await seal(this.env.SECRET_KEY, secret),
        new Date(now).toISOString(),
        expiresAt,
      );
      this.#broadcast(this.#rotationsEvent());
      return { machineId: machine.id, delivered: await this.#sendRotation(machine.id) };
    });
  }

  /** MM-208. */
  removeMachine(owner: OwnerContext, machineId: MachineId) {
    return this.#run(owner, async (): Promise<RemoveMachineResponse> => {
      const machine = findMachine(this.#map, machineId);
      if (!machine) throw new PortalError(404, `Unknown machine ${machineId}.`);
      const api = this.#cloudflare();
      let tokenDeleted = false;
      if (api) {
        const tokenId = await this.#tokenId(api, machine);
        if (tokenId) {
          for (const appId of this.#accessAppIds()) await api.removeTokenFromApp(appId, tokenId);
          await api.deleteServiceToken(tokenId);
          tokenDeleted = true;
        }
        const tunnelRow = this.#tunnelRow(machineId);
        if (tunnelRow) await this.#tearDownTunnel(api, tunnelRow);
      }
      this.#commit(ownerActor(owner), `Removed ${machine.name}`, [
        { _tag: "removeMachine", machineId },
      ]);
      for (const command of this.#commandsWithStatus("queued")) {
        if (command.machineId !== machineId) continue;
        this.#saveCommand({
          ...command,
          status: "cancelled",
          updatedAt: nowIso(),
          error: "The machine left the map.",
        });
      }
      this.ctx.storage.transactionSync(() => {
        for (const table of [
          "presence",
          "reported_settings",
          "join_codes",
          "rotations",
          "machine_tokens",
          "machine_tunnels",
        ]) {
          this.#sql(`DELETE FROM ${table} WHERE machine_id = ?`, machineId);
        }
      });
      this.#health.removeMachine(machineId);
      if (Object.hasOwn(this.#thresholds, machineId)) {
        const { [machineId]: _removed, ...rest } = this.#thresholds;
        this.#saveThresholds(rest);
      }
      this.#broadcast(this.#healthEvent());
      for (const ws of this.ctx.getWebSockets(machineTag(machineId)))
        ws.close(4004, "This machine left the map.");
      this.#broadcast(this.#rotationsEvent());
      return { machineId, tokenDeleted };
    });
  }

  applyPreset(owner: OwnerContext, name: string) {
    return this.#run(owner, (): WriteResult => {
      const preset = this.#presetChanges("apply", name);
      return {
        _tag: "applied",
        revision: this.#commit(ownerActor(owner), preset.summary, preset.changes).revision,
      };
    });
  }

  /**
   * MM-708 to MM-710: lock down every arrow and map role, remember them, and stop every agent.
   * Owner access through Cloudflare Access stays (MM-308).
   */
  pause(owner: OwnerContext) {
    return this.#run(owner, (): PauseResponse => {
      if (this.#pause) throw new PortalError(409, "Everything is already paused.");
      const actor = ownerActor(owner);
      const before = pausedAccess(this.#map);
      const changes = lockdownChanges(this.#map);
      const revision =
        changes.length > 0 ? this.#commit(actor, PAUSE_SUMMARY, changes, "pause").revision : null;
      const record: PauseRecord = { state: { pausedAt: nowIso(), by: actor, revision }, before };
      this.#savePause(record);
      // MM-709: every machine that joined, also one that did not report the command yet (no MM-502
      // check). A machine that never connected has no agents to stop.
      const joined = this.#map.machines.filter((machine) => hasJoined(this.#presence(machine.id)));
      for (const machine of joined) {
        this.#queueCommand(
          actor,
          machine.id,
          { _tag: "stopAllAgents" },
          "online",
          PAUSE_STOP_MINUTES,
        );
      }
      this.#notify(
        {
          title: "Everything is paused",
          body: `${owner.device} pressed the emergency pause. Agents stop on ${joined.length} ${joined.length === 1 ? "machine" : "machines"}.`,
          url: "/#/map",
          tag: "pause",
        },
        owner.signInId,
      );
      return { pause: record.state, stopCommands: joined.length };
    });
  }

  /** MM-712: return the arrows and map roles from before the pause. Agents do not start again. */
  resume(owner: OwnerContext) {
    return this.#run(owner, (): ResumeResponse => {
      const pause = this.#pause;
      if (!pause) throw new PortalError(409, "Nothing is paused.");
      const changes = resumeChanges(this.#map, pause.before);
      const revision =
        changes.length > 0
          ? this.#commit(ownerActor(owner), RESUME_SUMMARY, changes, "resume").revision
          : null;
      this.#savePause(null);
      return { revision };
    });
  }

  /** MM-1807: the public VAPID key that a browser subscribes with. */
  pushKey(owner: OwnerContext) {
    return this.#run(owner, async (): Promise<PushKeyResponse> => {
      const key = await this.#vapidKey().catch((error: unknown) => {
        throw new PortalError(500, `VAPID_JWK is invalid: ${errorMessage(error)}`);
      });
      return { publicKey: key?.publicKey ?? null };
    });
  }

  /** MM-1807: one subscription per device. A new subscription of the same endpoint replaces it. */
  subscribePush(owner: OwnerContext, request: PushSubscribeRequest) {
    return this.#run(owner, () => {
      this.#sql(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, sign_in_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, sign_in_id = excluded.sign_in_id`,
        request.endpoint,
        request.keys.p256dh,
        request.keys.auth,
        owner.signInId,
        nowIso(),
      );
      return { subscribed: true };
    });
  }

  unsubscribePush(owner: OwnerContext, request: PushEndpointRequest) {
    return this.#run(owner, () => {
      this.#sql("DELETE FROM push_subscriptions WHERE endpoint = ?", request.endpoint);
      return { subscribed: false };
    });
  }

  /** MM-1809: sends a test message to one device and reports the answer of its push service. */
  testPush(owner: OwnerContext, request: PushEndpointRequest) {
    return this.#run(owner, async () => {
      const target = this.#sql<{ endpoint: string; p256dh: string; auth: string }>(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?",
        request.endpoint,
      )[0];
      if (!target) throw new PortalError(404, "This device has no subscription. Turn it on again.");
      const key = await this.#vapidKey();
      if (!key) throw new PortalError(409, "The portal has no VAPID_JWK secret.");
      const message: PushMessage = {
        title: "Notifications work",
        body: "Health alerts, proposals and the emergency pause show here.",
        url: "/#/clients",
        tag: "test",
        badge: this.#proposals().length + this.#alerts("active").length,
      };
      const subject = `mailto:${ownerEmails(this.env)[0] ?? "owner@invalid"}`;
      const result = await sendPush(target, message, key, subject).catch((error: unknown) => {
        throw new PortalError(502, errorMessage(error));
      });
      if (result === "gone") {
        this.#sql("DELETE FROM push_subscriptions WHERE endpoint = ?", target.endpoint);
        throw new PortalError(410, "The push service forgot this device. Turn it on again.");
      }
      return "Test sent. It shows in a few seconds.";
    });
  }

  /** MM-901, MM-902 (the T3 sessions come from presence on the page). */
  devices(owner: OwnerContext) {
    return this.#run(owner, async (): Promise<DevicesResponse> => {
      const portalSignIns: Array<PortalSignIn> = this.#sql<{
        id: string;
        device: string;
        browser: string;
        place: string;
        first_seen: string;
        last_used: string;
      }>("SELECT * FROM sign_ins ORDER BY last_used DESC").map((row) => ({
        id: row.id,
        device: row.device,
        browser: row.browser,
        place: row.place,
        firstSeenAt: row.first_seen,
        lastUsedAt: row.last_used,
      }));
      const api = this.#cloudflare();
      if (!api) {
        return {
          portalSignIns,
          access: {
            _tag: "unavailable",
            message: "Add the CF_API_TOKEN secret to list Cloudflare Access sessions.",
          },
        };
      }
      try {
        return {
          portalSignIns,
          access: { _tag: "available", sessions: await api.ownerSessions(owner.email) },
        };
      } catch (error) {
        return { portalSignIns, access: { _tag: "unavailable", message: errorMessage(error) } };
      }
    });
  }

  /** MM-903: ends owner Access sessions and revokes owner T3 sessions on every machine. */
  signOutEverywhere(owner: OwnerContext) {
    return this.#run(owner, async (): Promise<SignOutEverywhereResponse> => {
      const api = this.#cloudflare();
      let accessMessage: string | null =
        "Cloudflare Access sessions need the CF_API_TOKEN secret. End them in the Zero Trust dashboard.";
      if (api) {
        await api.revokeOwner(owner.email);
        accessMessage = null;
      }
      let revokeCommands = 0;
      // Sessions of machines through their arrows are not owner sessions (MM-1305).
      const machineSubjects = new Set(this.#map.machines.map((m) => machineSessionSubject(m.id)));
      for (const machine of this.#map.machines) {
        const status = this.#presence(machine.id).status;
        if (!supportsCommand(status, "revokeClient")) continue;
        for (const client of status?.clients ?? []) {
          if (machineSubjects.has(client.subject)) continue;
          this.#createCommand(
            ownerActor(owner),
            machine.id,
            { _tag: "revokeClient", sessionId: client.sessionId },
            "online",
            DEFAULT_COMMAND_MINUTES,
          );
          revokeCommands += 1;
        }
      }
      this.#sql("DELETE FROM sign_ins");
      return { accessMessage, revokeCommands };
    });
  }

  #saveThresholds(thresholds: Readonly<Record<string, HealthThresholds>>): void {
    this.#sql(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('health_thresholds', ?)",
      JSON.stringify(thresholds),
    );
    this.#thresholds = thresholds;
  }

  /** MM-1504: the thresholds of one machine. Null returns it to the defaults. */
  setThresholds(owner: OwnerContext, machineId: MachineId, thresholds: HealthThresholds | null) {
    return this.#run(owner, (): ResourcesOverview => {
      if (!findMachine(this.#map, machineId)) {
        throw new PortalError(404, `Unknown machine ${machineId}.`);
      }
      const { [machineId]: _old, ...rest } = this.#thresholds;
      this.#saveThresholds(thresholds === null ? rest : { ...rest, [machineId]: thresholds });
      const nowMs = Date.now();
      this.#checkResources(machineId, nowMs);
      this.#checkOffline(machineId, nowMs);
      this.#broadcast(this.#healthEvent());
      return this.#overview("page");
    });
  }

  /** MM-1503: GET /api/machines/:id/resources?range. */
  resources(owner: OwnerContext, machineId: MachineId, range: ResourceRange) {
    return this.#run(owner, () => {
      if (!findMachine(this.#map, machineId)) {
        throw new PortalError(404, `Unknown machine ${machineId}.`);
      }
      return this.#resourceHistory(machineId, range);
    });
  }

  /** MM-1501: asks an online machine for a sample now. */
  requestSample(owner: OwnerContext, machineId: MachineId) {
    return this.#run(owner, (): SampleResponse => {
      if (!findMachine(this.#map, machineId)) {
        throw new PortalError(404, `Unknown machine ${machineId}.`);
      }
      const nowMs = Date.now();
      const last = this.#sampleRequests.get(machineId) ?? 0;
      if (nowMs - last < SAMPLE_REQUEST_GAP_MS) return { requested: false };
      const requested = this.#sendTo(machineId, { _tag: "sampleResources" });
      if (requested) this.#sampleRequests.set(machineId, nowMs);
      return { requested };
    });
  }

  /** MM-204, MM-1204: exchanges a join code for the machine token. Each code works once. */
  enroll(ip: string, code: string) {
    return this.#run(null, async (): Promise<EnrollResponse> => {
      const now = Date.now();
      const attempts = this.#sql<{ window_start: number; count: number }>(
        "SELECT window_start, count FROM enroll_attempts WHERE ip = ?",
        ip,
      )[0];
      const fresh = !attempts || now - attempts.window_start > ENROLL_WINDOW_MS;
      if (!fresh && attempts.count >= ENROLL_LIMIT) {
        throw new PortalError(429, "Too many join attempts. Wait 15 minutes.");
      }
      this.#sql(
        "INSERT OR REPLACE INTO enroll_attempts (ip, window_start, count) VALUES (?, ?, ?)",
        ip,
        fresh ? now : attempts.window_start,
        fresh ? 1 : attempts.count + 1,
      );
      const codeHash = await sha256Hex(normalizeJoinCode(code));
      // Read and delete in one step, so two requests cannot both use the code.
      const row = this.#sql<{
        machine_id: string;
        sealed_secret: string;
        expires_at: string;
        sealed_tunnel: string | null;
      }>(
        "DELETE FROM join_codes WHERE code_hash = ? RETURNING machine_id, sealed_secret, expires_at, sealed_tunnel",
        codeHash,
      )[0];
      const machine = row ? findMachine(this.#map, MachineId.make(row.machine_id)) : undefined;
      if (!row || !machine || isDue(row.expires_at, now)) {
        throw new PortalError(404, "Unknown, used or expired join code.");
      }
      this.#broadcast({ _tag: "enrolled", machineId: machine.id });
      return {
        machineId: machine.id,
        name: machine.name,
        kind: machine.kind,
        tokenClientId: machine.tokenClientId,
        tokenSecret: await unseal(this.env.SECRET_KEY, row.sealed_secret),
        tunnel:
          row.sealed_tunnel === null
            ? null
            : decodeTunnelGrant(await unseal(this.env.SECRET_KEY, row.sealed_tunnel)),
      };
    });
  }
}
