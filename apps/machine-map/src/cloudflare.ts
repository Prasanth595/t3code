/**
 * The Cloudflare API calls of the portal (MM-1205). The token needs "Access: Service Tokens Edit"
 * and "Access: Apps and Policies Edit". The machine tunnels (MM-213) also need "Cloudflare Tunnel:
 * Edit" on the account and "DNS: Edit" on the zone of the machine hostnames.
 * Field names come from the Cloudflare OpenAPI spec of the Access, Tunnel and DNS endpoints.
 */
import * as Schema from "effect/Schema";

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
    result: Schema.Unknown,
  }),
);

const ServiceToken = Schema.Struct({
  id: Schema.String,
  client_id: Schema.String,
  name: Schema.String,
  duration: Schema.optionalKey(Schema.String),
});
const NewSecret = Schema.Struct({ client_secret: Schema.String });

const decodeServiceTokenRule = Schema.decodeUnknownOption(
  Schema.Struct({ service_token: Schema.Struct({ token_id: Schema.String }) }),
);
const Policy = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  decision: Schema.String,
  include: Schema.Array(Schema.Unknown),
});
type Policy = typeof Policy.Type;

const AccessUser = Schema.Struct({ id: Schema.String, email: Schema.String });
const SessionSummary = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  expiration: Schema.optionalKey(Schema.Number),
  metadata: Schema.optionalKey(
    Schema.Struct({
      nonce: Schema.optionalKey(Schema.String),
      iat: Schema.optionalKey(Schema.Number),
    }),
  ),
});
const SessionDetail = Schema.Struct({
  ip: Schema.optionalKey(Schema.String),
  geo: Schema.optionalKey(Schema.Struct({ country: Schema.optionalKey(Schema.String) })),
});

const decodeNewToken = Schema.decodeUnknownSync(
  Schema.Struct({ ...ServiceToken.fields, ...NewSecret.fields }),
);
const decodeNewSecret = Schema.decodeUnknownSync(NewSecret);
const decodeServiceToken = Schema.decodeUnknownSync(ServiceToken);
const decodeServiceTokens = Schema.decodeUnknownSync(Schema.Array(ServiceToken));
const decodePolicies = Schema.decodeUnknownSync(Schema.Array(Policy));
const decodeUsers = Schema.decodeUnknownSync(Schema.Array(AccessUser));
const decodeSessions = Schema.decodeUnknownSync(Schema.Array(SessionSummary));
const decodeSessionDetail = Schema.decodeUnknownSync(SessionDetail);
const ignoreResult = (): void => undefined;

const Tunnel = Schema.Struct({ id: Schema.String, config_src: Schema.String });
type Tunnel = typeof Tunnel.Type;
const IngressRule = Schema.Struct({
  hostname: Schema.optionalKey(Schema.String),
  service: Schema.String,
});
const DnsRecord = Schema.Struct({ id: Schema.String, type: Schema.String, content: Schema.String });
export type DnsRecord = typeof DnsRecord.Type;

const decodeTunnel = Schema.decodeUnknownSync(Tunnel);
const decodeTunnels = Schema.decodeUnknownSync(Schema.Array(Tunnel));
const decodeTunnelToken = Schema.decodeUnknownSync(Schema.String);
const decodeTunnelConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    config: Schema.NullOr(
      Schema.Struct({ ingress: Schema.optionalKey(Schema.Array(IngressRule)) }),
    ).pipe(Schema.optionalKey),
  }),
);
const decodeDnsRecords = Schema.decodeUnknownSync(Schema.Array(DnsRecord));
const decodeDnsRecord = Schema.decodeUnknownSync(DnsRecord);
/** The fields of an Access app that the portal reads. A PUT sends back the whole app. */
const decodeAccessApp = Schema.decodeUnknownSync(
  Schema.Struct({
    aud: Schema.String,
    destinations: Schema.optionalKey(
      Schema.Array(Schema.Struct({ type: Schema.String, uri: Schema.optionalKey(Schema.String) })),
    ),
    policies: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
  }),
);
const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
/** Read-only fields of an Access app and of its policies. A PUT must not send them. */
const READ_ONLY_APP_FIELDS = ["id", "uid", "aud", "created_at", "updated_at"];
const READ_ONLY_POLICY_FIELDS = ["uid", "created_at", "updated_at", "reusable"];

/** The CNAME target of a tunnel. */
export const tunnelTarget = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;

/** The app policy that holds every machine token. The portal edits no other policy. */
export const MACHINE_POLICY_NAME = "t3 machine map tokens";

export interface OwnerSession {
  readonly name: string;
  readonly country: string | null;
  readonly ip: string | null;
  readonly signedInAt: string | null;
  readonly expiresAt: string | null;
}

const isoFromSeconds = (seconds: number | undefined): string | null =>
  seconds === undefined ? null : new Date(seconds * 1000).toISOString();

export class CloudflareApi {
  readonly #token: string;
  readonly #accountId: string;

  constructor(token: string, accountId: string) {
    this.#token = token;
    this.#accountId = accountId;
  }

  #call<T>(
    method: string,
    path: string,
    decode: (result: unknown) => T,
    body?: unknown,
  ): Promise<T> {
    return this.#request(method, `/accounts/${this.#accountId}${path}`, decode, body);
  }

  /** `path` starts after `/client/v4`, for example `/zones/<id>/dns_records`. */
  async #request<T>(
    method: string,
    path: string,
    decode: (result: unknown) => T,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = decodeEnvelope(await response.json());
    if (!response.ok || !envelope.success) {
      const detail = envelope.errors.map((e) => `${e.code} ${e.message}`).join("; ");
      throw new Error(`Cloudflare API ${method} ${path} failed: ${detail || response.status}`);
    }
    return decode(envelope.result);
  }

  createServiceToken(name: string) {
    return this.#call("POST", "/access/service_tokens", decodeNewToken, {
      name,
      duration: "forever",
    });
  }

  /** MM-207: the old secret keeps working until `previousExpiresAt`. */
  async rotateServiceToken(tokenId: string, previousExpiresAt: string): Promise<string> {
    const result = await this.#call(
      "POST",
      `/access/service_tokens/${tokenId}/rotate`,
      decodeNewSecret,
      {
        previous_client_secret_expires_at: previousExpiresAt,
      },
    );
    return result.client_secret;
  }

  /** Ends the old secret of a rotation now. PUT replaces the token, so it repeats name and duration. */
  async endPreviousSecret(tokenId: string): Promise<void> {
    const token = await this.#call("GET", `/access/service_tokens/${tokenId}`, decodeServiceToken);
    await this.#call("PUT", `/access/service_tokens/${tokenId}`, ignoreResult, {
      name: token.name,
      duration: token.duration ?? "forever",
      previous_client_secret_expires_at: new Date().toISOString(),
    });
  }

  async deleteServiceToken(tokenId: string): Promise<void> {
    await this.#call("DELETE", `/access/service_tokens/${tokenId}`, ignoreResult);
  }

  async findServiceTokenId(clientId: string): Promise<string | null> {
    const tokens = await this.#call(
      "GET",
      "/access/service_tokens?per_page=1000",
      decodeServiceTokens,
    );
    return tokens.find((token) => token.client_id === clientId)?.id ?? null;
  }

  async #machinePolicy(appId: string): Promise<Policy | undefined> {
    const policies = await this.#call("GET", `/access/apps/${appId}/policies`, decodePolicies);
    return policies.find((policy) => policy.name === MACHINE_POLICY_NAME);
  }

  /** MM-201: adds the token to the machine token policy of the app. Creates the policy once. */
  async addTokenToApp(appId: string, tokenId: string): Promise<void> {
    const rule = { service_token: { token_id: tokenId } };
    const policy = await this.#machinePolicy(appId);
    if (!policy) {
      await this.#call("POST", `/access/apps/${appId}/policies`, ignoreResult, {
        name: MACHINE_POLICY_NAME,
        decision: "non_identity",
        include: [rule],
      });
      return;
    }
    if (tokenIds(policy).includes(tokenId)) return;
    await this.#putPolicy(appId, policy, [...policy.include, rule]);
  }

  /** MM-208: removes the token from the policy. An empty policy is deleted. */
  async removeTokenFromApp(appId: string, tokenId: string): Promise<void> {
    const policy = await this.#machinePolicy(appId);
    if (!policy) return;
    const include = policy.include.filter((rule) => ruleTokenId(rule) !== tokenId);
    if (include.length === policy.include.length) return;
    if (include.length === 0) {
      await this.#call("DELETE", `/access/apps/${appId}/policies/${policy.id}`, ignoreResult);
      return;
    }
    await this.#putPolicy(appId, policy, include);
  }

  async #putPolicy(appId: string, policy: Policy, include: ReadonlyArray<unknown>): Promise<void> {
    await this.#call("PUT", `/access/apps/${appId}/policies/${policy.id}`, ignoreResult, {
      name: policy.name,
      decision: policy.decision,
      include,
    });
  }

  /** MM-901: owner sessions in Cloudflare Access. */
  async ownerSessions(email: string): Promise<Array<OwnerSession>> {
    const users = await this.#call(
      "GET",
      `/access/users?email=${encodeURIComponent(email)}`,
      decodeUsers,
    );
    const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return [];
    const sessions = await this.#call(
      "GET",
      `/access/users/${user.id}/active_sessions`,
      decodeSessions,
    );
    // Only the single-session endpoint reports the address and the country.
    return Promise.all(
      sessions.slice(0, 20).map(async (session) => {
        const nonce = session.metadata?.nonce;
        const detail = nonce
          ? await this.#call(
              "GET",
              `/access/users/${user.id}/active_sessions/${nonce}`,
              decodeSessionDetail,
            )
          : null;
        return {
          name: session.name ?? "Access session",
          country: detail?.geo?.country ?? null,
          ip: detail?.ip ?? null,
          signedInAt: isoFromSeconds(session.metadata?.iat),
          expiresAt: isoFromSeconds(session.expiration),
        };
      }),
    );
  }

  /** MM-903: ends every Access session of the owner. */
  async revokeOwner(email: string): Promise<void> {
    await this.#call("POST", "/access/organizations/revoke_user", ignoreResult, { email });
  }

  // ---------------------------------------------------------------- MM-213: machine tunnels

  async findTunnelByName(name: string): Promise<Tunnel | null> {
    const tunnels = await this.#call(
      "GET",
      `/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
      decodeTunnels,
    );
    return tunnels[0] ?? null;
  }

  async findTunnelById(tunnelId: string): Promise<Tunnel | null> {
    const tunnels = await this.#call(
      "GET",
      `/cfd_tunnel?is_deleted=false&uuid=${encodeURIComponent(tunnelId)}`,
      decodeTunnels,
    );
    return tunnels[0] ?? null;
  }

  /** A remotely managed tunnel: its ingress lives in Cloudflare, so `cloudflared` needs only the token. */
  createTunnel(name: string): Promise<Tunnel> {
    return this.#call("POST", "/cfd_tunnel", decodeTunnel, { name, config_src: "cloudflare" });
  }

  /**
   * Routes `hostname` to `service` and keeps the other rules of the tunnel. A rule for the
   * hostname that exists already stays as it is.
   */
  async ensureIngress(tunnelId: string, hostname: string, service: string): Promise<void> {
    const current = await this.#call(
      "GET",
      `/cfd_tunnel/${tunnelId}/configurations`,
      decodeTunnelConfig,
    );
    const rules = current.config?.ingress ?? [];
    if (rules.some((rule) => rule.hostname === hostname)) return;
    const named = rules.filter((rule) => rule.hostname !== undefined);
    await this.#call("PUT", `/cfd_tunnel/${tunnelId}/configurations`, ignoreResult, {
      config: { ingress: [{ hostname, service }, ...named, { service: "http_status:404" }] },
    });
  }

  tunnelToken(tunnelId: string): Promise<string> {
    return this.#call("GET", `/cfd_tunnel/${tunnelId}/token`, decodeTunnelToken);
  }

  /** Removes the connectors first, because Cloudflare deletes only a tunnel without connections. */
  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.#call("DELETE", `/cfd_tunnel/${tunnelId}/connections`, ignoreResult);
    await this.#call("DELETE", `/cfd_tunnel/${tunnelId}`, ignoreResult);
  }

  async findDnsRecord(zoneId: string, name: string): Promise<DnsRecord | null> {
    const records = await this.#request(
      "GET",
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
      decodeDnsRecords,
    );
    return records[0] ?? null;
  }

  createTunnelCname(zoneId: string, name: string, tunnelId: string): Promise<DnsRecord> {
    return this.#request("POST", `/zones/${zoneId}/dns_records`, decodeDnsRecord, {
      type: "CNAME",
      name,
      content: tunnelTarget(tunnelId),
      proxied: true,
      comment: "T3 machine map",
    });
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.#request("DELETE", `/zones/${zoneId}/dns_records/${recordId}`, ignoreResult);
  }

  /** The audience tag of an Access app: `T3CODE_CLOUDFLARE_ACCESS_AUD` of its hostnames. */
  async accessAppAud(appId: string): Promise<string> {
    return (await this.#call("GET", `/access/apps/${appId}`, decodeAccessApp)).aud;
  }

  /** Adds `hostname` to the public destinations of an Access app. False when it is there already. */
  addAppHostname(appId: string, hostname: string): Promise<boolean> {
    return this.#editAppHostnames(appId, (hostnames) =>
      hostnames.includes(hostname) ? null : [...hostnames, hostname],
    );
  }

  /** Removes `hostname` from the public destinations of an Access app. */
  removeAppHostname(appId: string, hostname: string): Promise<boolean> {
    return this.#editAppHostnames(appId, (hostnames) =>
      hostnames.includes(hostname) ? hostnames.filter((h) => h !== hostname) : null,
    );
  }

  /**
   * PUT replaces the whole app, so it sends back every field that GET gave, with the policies of
   * the app. It checks that the app keeps each policy, because a lost policy locks the owner out.
   */
  async #editAppHostnames(
    appId: string,
    edit: (hostnames: ReadonlyArray<string>) => ReadonlyArray<string> | null,
  ): Promise<boolean> {
    const raw = await this.#call("GET", `/access/apps/${appId}`, decodeRecord);
    const app = decodeAccessApp(raw);
    const destinations = app.destinations ?? [];
    const hostnames = destinations.flatMap((d) =>
      d.type === "public" && d.uri !== undefined ? [d.uri] : [],
    );
    const next = edit(hostnames);
    if (next === null) return false;
    if (next.length === 0) throw new Error("An Access app needs at least one hostname.");
    const body: Record<string, unknown> = { ...raw };
    for (const field of READ_ONLY_APP_FIELDS) delete body[field];
    // `self_hosted_domains` is the deprecated twin of the public destinations.
    delete body.self_hosted_domains;
    body.domain = next[0];
    body.destinations = [
      ...destinations.filter((d) => d.type !== "public"),
      ...next.map((uri) => ({ type: "public", uri })),
    ];
    if (Array.isArray(raw.policies)) {
      body.policies = raw.policies.map((policy) => {
        const copy = { ...decodeRecord(policy) };
        for (const field of READ_ONLY_POLICY_FIELDS) delete copy[field];
        return copy;
      });
    }
    const updated = await this.#call("PUT", `/access/apps/${appId}`, decodeAccessApp, body);
    const kept = new Set((updated.policies ?? []).map((policy) => policy.id));
    const lost = (app.policies ?? []).filter((policy) => !kept.has(policy.id));
    if (lost.length > 0) {
      throw new Error(
        `The Access app ${appId} lost ${lost.length} policies in the hostname update. Check it in the Zero Trust dashboard now.`,
      );
    }
    return true;
  }
}

const ruleTokenId = (rule: unknown): string | null => {
  const decoded = decodeServiceTokenRule(rule);
  return decoded._tag === "Some" ? decoded.value.service_token.token_id : null;
};

const tokenIds = (policy: Policy): Array<string> =>
  policy.include.map(ruleTokenId).filter((id): id is string => id !== null);
