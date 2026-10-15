/**
 * The portal Worker (MM-101). It checks Cloudflare Access, decodes requests with the shapes in
 * `api.ts`, and calls the one Durable Object. Static pages come from Workers Static Assets.
 */
import * as Schema from "effect/Schema";
import { ClientEnrollRequest, ClientId, MachineId } from "@t3tools/contracts/machineMap";
import { RESOURCE_RANGES } from "@t3tools/contracts/machineMapResources";

import { approvalEmail, clientTokenId, machineClientId, ownerEmail } from "./access.ts";
import {
  AddMachineRequest,
  ApproveClientRequest,
  ChangesRequest,
  CommandRequest,
  InviteRequest,
  EnrollRequest,
  JoinCodeRequest,
  PushEndpointRequest,
  PushSubscribeRequest,
  RevisionRequest,
  ThresholdsRequest,
} from "./api.ts";
import { APPROVALS_MAX_SECONDS, APPROVALS_PATH, CLIENT_PATH, INVITE_PATH } from "./cloudflare.ts";
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
const ID_RESOURCES = new Set(["commands", "proposals", "machines", "presets", "pending"]);

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

async function ownerContext(request: Request, email: string | null): Promise<OwnerContext | null> {
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

/** A write from another site. A page of the portal sends its own origin, or none. */
const crossOrigin = (request: Request, url: URL): boolean =>
  request.method !== "GET" &&
  request.headers.get("Origin") !== null &&
  request.headers.get("Origin") !== url.origin;

/**
 * MM-1207: the approval path. Its own Access app asks for a fresh MFA, so its JWT has another
 * audience than the pages. Only actions that let a browser key in run here.
 */
async function grant(request: Request, env: Env, url: URL): Promise<Response> {
  const stub = mapObject(env);
  const email = await approvalEmail(request, env, await stub.approvalsAud(), APPROVALS_MAX_SECONDS);
  const owner = await ownerContext(request, email);
  if (!owner) return fail(403, "Approvals need a fresh passkey check. Confirm with it again.");
  if (crossOrigin(request, url)) return fail(403, "Wrong origin.");
  const route = `${request.method} ${url.pathname.slice(APPROVALS_PATH.length)}`;
  switch (route) {
    case "GET /start": {
      // The page comes here for the MFA, then goes back to its own route. Only a hash route.
      const then = url.searchParams.get("then") ?? "";
      return Response.redirect(new URL(`/${then.startsWith("#/") ? then : ""}`, url).href, 303);
    }
    case "GET /check":
      return json({ ok: true });
    case "POST /approve": {
      const body = await readBody(request, ApproveClientRequest);
      return body instanceof Response
        ? body
        : toResponse(await stub.approveClient(owner, url.host, body));
    }
    case "POST /invite": {
      const body = await readBody(request, InviteRequest);
      return body instanceof Response
        ? body
        : toResponse(await stub.createInvite(owner, url.host, body));
    }
    default:
      return fail(404, `No route ${request.method} ${url.pathname}.`);
  }
}

const RemoveClientRequest = Schema.Struct({ clientId: ClientId });

/** MM-913: a phone browser that opens an invite link. The code is for the T3 app, not the page. */
const INVITE_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>T3 invite</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1>Open this invite in the T3 app</h1><p>Scan the QR code with the T3 app on your phone, or paste this link there. The page itself does nothing.</p>`;

const integer = (value: string | null): number | null => {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
};

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const owner = await ownerContext(request, await ownerEmail(request, env));
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
  if (crossOrigin(request, url)) return fail(403, "Wrong origin.");

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
    case "GET /machines/:id/resources": {
      const range = url.searchParams.get("range") ?? "hour";
      const known = RESOURCE_RANGES.find((r) => r === range);
      if (known === undefined) return fail(400, `range is one of ${RESOURCE_RANGES.join(", ")}.`);
      return toResponse(await stub.resources(owner, MachineId.make(id), known));
    }
    case "POST /machines/:id/sample":
      return toResponse(await stub.requestSample(owner, MachineId.make(id)));
    case "POST /machines/:id/thresholds": {
      const body = await readBody(request, ThresholdsRequest);
      return body instanceof Response
        ? body
        : toResponse(await stub.setThresholds(owner, MachineId.make(id), body.thresholds));
    }
    case "POST /presets/:id/apply":
      return toResponse(await stub.applyPreset(owner, id));
    case "POST /pause":
      return toResponse(await stub.pause(owner));
    case "POST /resume":
      return toResponse(await stub.resume(owner));
    case "GET /fork-release":
      return json(await fetchNewestRelease());
    case "GET /clients/approvals":
      return toResponse(await stub.approvalsStatus(owner, url.host));
    case "POST /clients/approvals":
      return toResponse(await stub.setUpApprovals(owner, url.host));
    case "POST /clients/remove": {
      const body = await readBody(request, RemoveClientRequest);
      return body instanceof Response
        ? body
        : toResponse(await stub.removeClient(owner, body.clientId));
    }
    case "POST /pending/:id/reject":
      return toResponse(await stub.rejectPendingClient(owner, id));
    case "POST /pending/:id/unblock":
      return toResponse(await stub.unblockPendingClient(owner, id));
    case "GET /devices":
      return toResponse(await stub.devices(owner));
    case "POST /devices/sign-out-everywhere":
      return toResponse(await stub.signOutEverywhere(owner));
    case "GET /push":
      return toResponse(await stub.pushKey(owner));
    case "POST /push/subscribe": {
      const body = await readBody(request, PushSubscribeRequest);
      return body instanceof Response ? body : toResponse(await stub.subscribePush(owner, body));
    }
    case "POST /push/unsubscribe": {
      const body = await readBody(request, PushEndpointRequest);
      return body instanceof Response ? body : toResponse(await stub.unsubscribePush(owner, body));
    }
    case "POST /push/test": {
      const body = await readBody(request, PushEndpointRequest);
      return body instanceof Response ? body : toResponse(await stub.testPush(owner, body));
    }
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
    if (url.pathname === INVITE_PATH) {
      // MM-913: a Bypass Access app leaves this path open. The invite code is the credential.
      if (request.method === "GET")
        return new Response(INVITE_PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      if (request.method !== "POST") return fail(405, "Use POST.");
      const body = await readBody(request, ClientEnrollRequest);
      if (body instanceof Response) return body;
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      return toResponse(await mapObject(env).redeemInvite(ip, url.host, body));
    }
    if (url.pathname === `${CLIENT_PATH}/machines`) {
      // MM-914: only the app token of a client gets its machines.
      if (request.method !== "GET") return fail(405, "Use GET.");
      const stub = mapObject(env);
      const tokenId = await clientTokenId(request, env, await stub.clientAppAud());
      if (!tokenId) return fail(403, "An app token of a client is required.");
      return toResponse(await stub.machinesOfToken(tokenId));
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
    if (url.pathname.startsWith(`${APPROVALS_PATH}/`)) return grant(request, env, url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    return fail(404, "Not found.");
  },
} satisfies ExportedHandler<Env>;
