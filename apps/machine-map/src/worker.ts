/**
 * The portal Worker (MM-101). It checks Cloudflare Access, decodes requests with the shapes in
 * `api.ts`, and calls the one Durable Object. Static pages come from Workers Static Assets.
 */
import * as Schema from "effect/Schema";
import { MachineId } from "@t3tools/contracts/machineMap";

import { machineClientId, ownerEmail } from "./access.ts";
import {
  AddMachineRequest,
  ChangesRequest,
  CommandRequest,
  EnrollRequest,
  JoinCodeRequest,
  RevisionRequest,
} from "./api.ts";
import type { Env } from "./env.ts";
import { MACHINE_CLIENT_ID_HEADER, type Outcome, type OwnerContext } from "./MachineMapObject.ts";
import { fetchNewestRelease } from "./releases.ts";
import { describeUserAgent } from "./rules/device.ts";
import { sha256Hex } from "./sealedSecret.ts";

export { MachineMapObject } from "./MachineMapObject.ts";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const fail = (status: number, error: string): Response => json({ error }, status);

const toResponse = <T>(outcome: Outcome<T>): Response =>
  outcome.ok ? json(outcome.value) : fail(outcome.status, outcome.error);

const mapObject = (env: Env) => env.MAP.getByName("map");

/** API paths of the form `/api/<resource>/<id>/...`. */
const ID_RESOURCES = new Set(["commands", "proposals", "machines", "presets"]);

async function readBody<T>(
  request: Request,
  schema: Schema.ConstraintDecoder<T>,
): Promise<T | Response> {
  // A JSON content type cannot come from a plain cross-site form, which keeps writes same-origin.
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    return fail(415, "Send JSON with Content-Type: application/json.");
  }
  try {
    return Schema.decodeUnknownSync(schema)(await request.json());
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "Invalid request body.");
  }
}

async function ownerContext(request: Request, env: Env): Promise<OwnerContext | null> {
  const email = await ownerEmail(request, env);
  if (!email) return null;
  const userAgent = request.headers.get("User-Agent");
  const { device, browser } = describeUserAgent(userAgent);
  const cf = request.cf;
  const city = typeof cf?.city === "string" ? cf.city : null;
  const country = typeof cf?.country === "string" ? cf.country : null;
  return {
    email,
    signInId: (await sha256Hex(`${email}\n${userAgent ?? ""}`)).slice(0, 16),
    device,
    browser,
    place: [city, country].filter((part) => part !== null).join(", ") || "Unknown place",
  };
}

const integer = (value: string | null): number | null => {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
};

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const owner = await ownerContext(request, env);
  // MM-102: fail closed.
  if (!owner) return fail(403, "Only the owner can use the portal.");
  const stub = mapObject(env);
  const parts = url.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .slice(1);
  const hasId = ID_RESOURCES.has(parts[0] ?? "") && parts.length > 1;
  const route = `${request.method} /${parts.map((part, i) => (hasId && i === 1 ? ":id" : part)).join("/")}`;
  const id = hasId ? decodeURIComponent(parts[1] ?? "") : "";

  if (route === "GET /events") {
    if (request.headers.get("Upgrade") !== "websocket")
      return fail(426, "Expected a WebSocket upgrade.");
    // Cross-site WebSocket hijacking guard: a page socket opens only from the portal itself.
    if (request.headers.get("Origin") !== url.origin) return fail(403, "Wrong origin.");
    return stub.fetch(new Request(new URL("/api/events", url), request));
  }
  if (
    request.method !== "GET" &&
    request.headers.get("Origin") !== null &&
    request.headers.get("Origin") !== url.origin
  ) {
    return fail(403, "Wrong origin.");
  }

  switch (route) {
    case "GET /snapshot":
      return toResponse(await stub.snapshot(owner));
    case "POST /changes": {
      const body = await readBody(request, ChangesRequest);
      return body instanceof Response ? body : toResponse(await stub.changes(owner, body));
    }
    case "POST /commands": {
      const body = await readBody(request, CommandRequest);
      return body instanceof Response ? body : toResponse(await stub.createCommand(owner, body));
    }
    case "POST /commands/:id/cancel":
      return toResponse(await stub.cancelCommand(owner, id));
    case "POST /undo": {
      const body = await readBody(request, RevisionRequest);
      return body instanceof Response ? body : toResponse(await stub.undo(owner, body.revision));
    }
    case "POST /restore": {
      const body = await readBody(request, RevisionRequest);
      return body instanceof Response ? body : toResponse(await stub.restore(owner, body.revision));
    }
    case "GET /history": {
      const before = integer(url.searchParams.get("before"));
      const limit = integer(url.searchParams.get("limit")) ?? 50;
      if (Number.isNaN(before) || Number.isNaN(limit))
        return fail(400, "before and limit are integers.");
      return toResponse(await stub.history(owner, before, limit));
    }
    case "GET /map-at": {
      const revision = integer(url.searchParams.get("revision"));
      if (revision === null || Number.isNaN(revision) || revision < 0)
        return fail(400, "revision is required.");
      return toResponse(await stub.mapAt(owner, revision));
    }
    case "POST /proposals/:id/approve":
      return toResponse(await stub.approveProposal(owner, id));
    case "POST /proposals/:id/reject":
      return toResponse(await stub.rejectProposal(owner, id));
    case "POST /machines": {
      const body = await readBody(request, AddMachineRequest);
      return body instanceof Response ? body : toResponse(await stub.addMachine(owner, body));
    }
    case "POST /machines/:id/join-code": {
      const body = await readBody(request, JoinCodeRequest);
      return body instanceof Response
        ? body
        : toResponse(await stub.newJoinCode(owner, MachineId.make(id), body));
    }
    case "POST /machines/:id/rotate":
      return toResponse(await stub.rotateToken(owner, MachineId.make(id)));
    case "DELETE /machines/:id":
      return toResponse(await stub.removeMachine(owner, MachineId.make(id)));
    case "POST /presets/:id/apply":
      return toResponse(await stub.applyPreset(owner, id));
    case "POST /lockdown":
      return toResponse(await stub.lockdown(owner));
    case "POST /pause":
      return toResponse(await stub.pause(owner));
    case "POST /resume":
      return toResponse(await stub.resume(owner));
    case "GET /fork-release":
      return json(await fetchNewestRelease());
    case "GET /devices":
      return toResponse(await stub.devices(owner));
    case "POST /devices/sign-out-everywhere":
      return toResponse(await stub.signOutEverywhere(owner));
    default:
      return fail(404, `No route ${request.method} ${url.pathname}.`);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/enroll") {
      // MM-204: a bypass Access app leaves this path open. The join code is the credential.
      if (request.method !== "POST") return fail(405, "Use POST.");
      const body = await readBody(request, EnrollRequest);
      if (body instanceof Response) return body;
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      return toResponse(await mapObject(env).enroll(ip, body.code));
    }
    if (url.pathname === "/connect") {
      // MM-104: only a valid machine token JWT of the /connect Access app connects.
      const clientId = await machineClientId(request, env);
      if (!clientId) return fail(403, "A machine token is required.");
      if (request.headers.get("Upgrade") !== "websocket")
        return fail(426, "Expected a WebSocket upgrade.");
      const forwarded = new Request(new URL("/connect", url), request);
      forwarded.headers.set(MACHINE_CLIENT_ID_HEADER, clientId);
      return mapObject(env).fetch(forwarded);
    }
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    return fail(404, "Not found.");
  },
} satisfies ExportedHandler<Env>;
