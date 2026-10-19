import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { CloudflareApi } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { MachineMapObject, type OwnerContext } from "./MachineMapObject.ts";
import { emptyMap } from "./rules/map.ts";
import { MAC, threeMachines } from "./rules/testMap.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: DurableObjectState;
    readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const owner: OwnerContext = {
  email: "owner@example.com",
  signInId: "device-1",
  device: "Phone",
  browser: "Chrome",
  place: "Test",
};
const databases: Array<NodeSqlite.DatabaseSync> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      readonly request: string;
      readonly response: string;
      constructor(request: string, response: string) {
        this.request = request;
        this.response = response;
      }
    },
  );
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function portal(machines = false) {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta VALUES ('map', ?)").run(
    JSON.stringify(machines ? threeMachines() : emptyMap()),
  );
  db.prepare("INSERT INTO meta VALUES ('absolute_places', ?)").run(new Date().toISOString());
  const send = vi.fn();
  const setAlarm = vi.fn(async (_at: number) => {});
  const ctx = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: (tag: string) => (tag === "page" ? [{ send }] : []),
    waitUntil: (_work: Promise<unknown>) => {},
    storage: {
      sql: {
        exec(query: string, ...bindings: Array<string | number | null>) {
          if (query.trim().startsWith("CREATE")) {
            db.exec(query);
            return { toArray: () => [] };
          }
          const rows = db.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
      transactionSync: (work: () => unknown) => work(),
      setAlarm,
      deleteAlarm: vi.fn(async () => {}),
    },
  } as unknown as DurableObjectState;
  const env = {
    SECRET_KEY: btoa("a".repeat(32)),
    ACCOUNT_ID: "account",
    OWNER_EMAILS: owner.email,
    TEAM_DOMAIN: "team.cloudflareaccess.com",
    ...(machines ? { CF_API_TOKEN: "test-only" } : {}),
  } as Env;
  return { db, ctx, env, object: new MachineMapObject(ctx, env), send, setAlarm };
}

it("reads push registration without restoring a subscription deleted by sign-out", async () => {
  const { object, db } = portal();
  const request = {
    endpoint: "https://push.example.com/device",
    keys: { p256dh: "key", auth: "auth" },
  };
  await object.subscribePush(owner, request);
  expect(await object.pushStatus(owner, request)).toEqual({
    ok: true,
    value: { subscribed: true },
  });
  expect((await object.signOutEverywhere(owner)).ok).toBe(true);
  for (let i = 0; i < 2; i++) {
    expect(await object.pushStatus(owner, request)).toEqual({
      ok: true,
      value: { subscribed: false },
    });
  }
  expect(db.prepare("SELECT * FROM push_subscriptions").all()).toEqual([]);
  await object.subscribePush(owner, request);
  expect(await object.pushStatus(owner, request)).toEqual({
    ok: true,
    value: { subscribed: true },
  });
});

it("wipes an unconfirmed rotation at its 24-hour deadline but keeps the rejoin marker through restart", async () => {
  const { object, db, ctx, env, send, setAlarm } = portal(true);
  db.prepare("INSERT INTO machine_tokens VALUES (?, ?)").run(MAC, "token-id");
  const rotate = vi
    .spyOn(CloudflareApi.prototype, "rotateServiceToken")
    .mockResolvedValue("new-secret");
  expect(await object.rotateToken(owner, MAC)).toEqual({
    ok: true,
    value: { machineId: MAC, delivered: false },
  });
  const deadline = "2026-10-21T08:00:00.000Z";
  expect(rotate).toHaveBeenCalledWith("token-id", deadline);
  vi.setSystemTime(new Date(Date.parse(deadline) - 1));
  await object.alarm();
  expect(db.prepare("SELECT sealed_secret FROM rotations").get()?.sealed_secret).not.toBe("");
  setAlarm.mockClear();
  vi.setSystemTime(new Date(deadline));
  await object.alarm();
  expect(db.prepare("SELECT sealed_secret, expires_at FROM rotations").get()).toEqual({
    sealed_secret: "",
    expires_at: deadline,
  });
  expect(send.mock.calls.map(([text]) => JSON.parse(text))).toContainEqual({
    _tag: "rotations",
    rotations: [
      { machineId: MAC, createdAt: "2026-10-20T08:00:00.000Z", expiresAt: deadline, expired: true },
    ],
  });
  expect(setAlarm).not.toHaveBeenCalled();
  expect(ctx.storage.deleteAlarm).toHaveBeenCalled();
  const restarted = new MachineMapObject(ctx, env);
  expect(await restarted.rotateToken(owner, MAC)).toEqual({
    ok: false,
    status: 409,
    error: "Join again with a new code before rotating this token.",
  });
  expect(rotate).toHaveBeenCalledOnce();
  const join = await restarted.newJoinCode(owner, MAC, { tokenSecret: "recovery-secret" });
  expect(join.ok).toBe(true);
  if (!join.ok) throw new Error(join.error);
  expect(db.prepare("SELECT sealed_secret FROM rotations").get()?.sealed_secret).toBe("");
  expect((await restarted.enroll("127.0.0.1", join.value.code)).ok).toBe(true);
  expect(db.prepare("SELECT * FROM rotations").all()).toEqual([]);
});

it("does not mark a confirmed rotation as needing a rejoin after the deadline", async () => {
  const { object, db } = portal(true);
  db.prepare("INSERT INTO machine_tokens VALUES (?, ?)").run(MAC, "token-id");
  vi.spyOn(CloudflareApi.prototype, "rotateServiceToken").mockResolvedValue("new-secret");
  const endPrevious = vi
    .spyOn(CloudflareApi.prototype, "endPreviousSecret")
    .mockResolvedValue(undefined);
  await object.rotateToken(owner, MAC);
  const socket = {
    deserializeAttachment: () => ({ kind: "machine", machineId: MAC }),
  } as WebSocket;
  await object.webSocketMessage(
    socket,
    JSON.stringify({ _tag: "rotated", tokenClientId: "mac.access" }),
  );
  expect(endPrevious).toHaveBeenCalledWith("token-id");
  vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z"));
  await object.alarm();
  expect(db.prepare("SELECT * FROM rotations").all()).toEqual([]);
});
