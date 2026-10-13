/**
 * The Cloudflare API calls of the portal (MM-1205). The token needs only
 * "Access: Service Tokens Edit" and "Access: Apps and Policies Edit".
 * Field names come from the Cloudflare OpenAPI spec of the Access endpoints.
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

  async #call<T>(
    method: string,
    path: string,
    decode: (result: unknown) => T,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.#accountId}${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
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
}

const ruleTokenId = (rule: unknown): string | null => {
  const decoded = decodeServiceTokenRule(rule);
  return decoded._tag === "Some" ? decoded.value.service_token.token_id : null;
};

const tokenIds = (policy: Policy): Array<string> =>
  policy.include.map(ruleTokenId).filter((id): id is string => id !== null);
