import { createClerkClient } from "@clerk/backend";
import { RelayApi, RelayClientPrincipal, RelayInternalError } from "@t3tools/contracts/relay";
import {
  SAAS_LLM_MODEL_ID,
  SaasForbiddenError,
  SaasInvalidRequestError,
  SaasNotFoundError,
} from "@t3tools/contracts/saas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as RelayConfiguration from "../Config.ts";
import * as SaasAccounts from "./SaasAccounts.ts";
import * as StripeBilling from "./StripeBilling.ts";

export const DEFAULT_SAAS_ADMIN_EMAILS = ["contact@andreimiron.ro"];

/** Admin access is granted by verified email, so Clerk stays the source of truth. */
export const isAdminEmail = (email: string | null, adminEmails: ReadonlyArray<string>) =>
  email !== null &&
  adminEmails.some((admin) => admin.trim().toLowerCase() === email.trim().toLowerCase());

export class SaasAdmins extends Context.Service<SaasAdmins, ReadonlyArray<string>>()(
  "t3code-relay/saas/SaasApi/SaasAdmins",
) {}

export class ClerkUsers extends Context.Service<
  ClerkUsers,
  {
    /** The user's verified primary email, or null when Clerk has none. */
    readonly primaryEmail: (userId: string) => Effect.Effect<string | null>;
  }
>()("t3code-relay/saas/SaasApi/ClerkUsers") {}

export const layerClerkUsers = Layer.effect(
  ClerkUsers,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const client = createClerkClient({
      secretKey: Redacted.value(config.clerkSecretKey),
      publishableKey: config.clerkPublishableKey,
    });
    return ClerkUsers.of({
      primaryEmail: (userId) =>
        Effect.tryPromise(() => client.users.getUser(userId)).pipe(
          Effect.map((user) => {
            const primary = user.emailAddresses.find(
              (address) => address.id === user.primaryEmailAddressId,
            );
            return primary?.verification?.status === "verified" ? primary.emailAddress : null;
          }),
          Effect.catch((error) =>
            Effect.logWarning("Failed to read Clerk user", { error }).pipe(Effect.as(null)),
          ),
          Effect.withSpan("relay.saas.clerk_primary_email"),
        ),
    });
  }),
);

const isSaasPersistenceError = Schema.is(SaasAccounts.SaasPersistenceError);

const internalError = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
  Effect.flatMap((traceId) =>
    Effect.fail(
      new RelayInternalError({ code: "internal_error", reason: "persistence_failed", traceId }),
    ),
  ),
);

const mapPersistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is Extract<E, SaasAccounts.SaasPersistenceError> =>
        isSaasPersistenceError(error),
      () => internalError,
    ),
  );

export const layerAccountApi = HttpApiBuilder.group(
  RelayApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* SaasAccounts.SaasAccounts;
    const clerkUsers = yield* ClerkUsers;
    const admins = yield* SaasAdmins;
    const config = yield* RelayConfiguration.RelayConfiguration;
    const billing = yield* StripeBilling.StripeBilling;
    return handlers
      .handle(
        "getAccount",
        Effect.fn("relay.api.account.get")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          const email = yield* clerkUsers.primaryEmail(userId);
          const account = yield* accounts.getAccount({ userId, email });
          return { ...account, isAdmin: isAdminEmail(email, admins) };
        }, mapPersistence),
      )
      .handle(
        "createLlmKey",
        Effect.fn("relay.api.account.create_llm_key")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          yield* accounts.getAccount({ userId, email: yield* clerkUsers.primaryEmail(userId) });
          const apiKey = yield* accounts.createLlmKey(userId);
          return {
            apiKey,
            baseUrl: `${config.relayIssuer.replace(/\/+$/, "")}/v1/llm`,
            model: SAAS_LLM_MODEL_ID,
          };
        }, mapPersistence),
      )
      .handle(
        "createCheckout",
        Effect.fn("relay.api.account.create_checkout")(function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          const email = yield* clerkUsers.primaryEmail(userId);
          yield* accounts.getAccount({ userId, email });
          return { url: yield* billing.createCheckout({ userId, email, planId: payload.planId }) };
        }, mapPersistence),
      )
      .handle(
        "createBillingPortal",
        Effect.fn("relay.api.account.create_billing_portal")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return { url: yield* billing.createPortal(userId) };
        }, mapPersistence),
      );
  }),
);

const requireAdmin = Effect.fn("relay.api.admin.require")(function* () {
  const { userId } = yield* RelayClientPrincipal;
  const clerkUsers = yield* ClerkUsers;
  const admins = yield* SaasAdmins;
  if (!isAdminEmail(yield* clerkUsers.primaryEmail(userId), admins)) {
    return yield* new SaasForbiddenError({ code: "forbidden" });
  }
});

export const layerAdminApi = HttpApiBuilder.group(
  RelayApi,
  "admin",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* SaasAccounts.SaasAccounts;
    const clerkUsers = yield* ClerkUsers;
    const admins = yield* SaasAdmins;
    const asAdmin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      requireAdmin().pipe(
        Effect.provideService(ClerkUsers, clerkUsers),
        Effect.provideService(SaasAdmins, admins),
        Effect.andThen(effect),
        mapPersistence,
      );
    return handlers
      .handle("listUsers", () =>
        asAdmin(accounts.listUsers.pipe(Effect.map((users) => ({ users })))),
      )
      .handle("setUserPlan", ({ params, payload }) =>
        asAdmin(
          accounts.setUserPlan({ userId: params.userId, planId: payload.planId }).pipe(
            Effect.as({ ok: true }),
            Effect.catchTags({
              SaasPlanNotFound: () =>
                Effect.fail(new SaasNotFoundError({ code: "not_found", resource: "plan" })),
              SaasUserNotFound: () =>
                Effect.fail(new SaasNotFoundError({ code: "not_found", resource: "user" })),
            }),
          ),
        ),
      )
      .handle("listPlans", () =>
        asAdmin(accounts.listPlans.pipe(Effect.map((plans) => ({ plans })))),
      )
      .handle("savePlan", ({ params, payload }) =>
        asAdmin(
          Effect.gen(function* () {
            if (payload.id !== params.planId) {
              return yield* new SaasInvalidRequestError({
                code: "invalid_request",
                message: "The plan id in the body must match the path.",
              });
            }
            return yield* accounts.savePlan(payload);
          }),
        ),
      )
      .handle("getSettings", () => asAdmin(accounts.getSettings))
      .handle("saveSettings", ({ payload }) => asAdmin(accounts.saveSettings(payload)));
  }),
);
