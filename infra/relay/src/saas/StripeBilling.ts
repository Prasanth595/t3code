import { RelayApi } from "@t3tools/contracts/relay";
import { SaasBillingUnavailableError, SaasNotFoundError } from "@t3tools/contracts/saas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as SaasAccounts from "./SaasAccounts.ts";

const STRIPE_API = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeSettings {
  readonly secretKey: Redacted.Redacted<string>;
  readonly webhookSecret: Redacted.Redacted<string>;
  /** Origin Checkout and the portal return to. */
  readonly returnOrigin: string;
}

/** Null until the Stripe secrets are configured, so billing fails closed. */
export class StripeConfig extends Context.Service<StripeConfig, StripeSettings | null>()(
  "t3code-relay/saas/StripeBilling/StripeConfig",
) {}

const hmacSha256Hex = (secret: string, payload: string) =>
  Effect.promise(async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    return Hex.encode(new Uint8Array(signature));
  });

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

/** Verifies a `Stripe-Signature` header against the raw body. */
export const verifyStripeSignature = Effect.fn("StripeBilling.verifySignature")(function* (input: {
  readonly header: string | undefined;
  readonly body: string;
  readonly secret: string;
  readonly nowSeconds: number;
}) {
  const parts = (input.header ?? "").split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(input.nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = yield* hmacSha256Hex(input.secret, `${timestamp}.${input.body}`);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
});

class StripeRequestError extends Schema.TaggedError<StripeRequestError>()("StripeRequestError", {
  status: Schema.Number,
  body: Schema.Unknown,
}) {}

const StripeObjectId = Schema.Struct({ id: Schema.String });

const StripeEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({ object: Schema.Unknown }),
});

const CheckoutSession = Schema.Struct({
  customer: Schema.NullOr(Schema.String),
  client_reference_id: Schema.NullOr(Schema.String),
});

const Subscription = Schema.Struct({
  id: Schema.String,
  customer: Schema.String,
  status: Schema.String,
  items: Schema.Struct({
    data: Schema.Array(Schema.Struct({ price: Schema.Struct({ id: Schema.String }) })),
  }),
});

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(StripeEvent));
const decodeCheckoutSession = Schema.decodeUnknownOption(CheckoutSession);
const decodeSubscription = Schema.decodeUnknownOption(Subscription);
const decodeObjectId = Schema.decodeUnknownEffect(StripeObjectId);
const decodeRedirect = Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }));

export class StripeBilling extends Context.Service<
  StripeBilling,
  {
    readonly createCheckout: (input: {
      readonly userId: string;
      readonly email: string | null;
      readonly planId: string;
    }) => Effect.Effect<
      string,
      SaasBillingUnavailableError | SaasNotFoundError | SaasAccounts.SaasPersistenceError
    >;
    readonly createPortal: (
      userId: string,
    ) => Effect.Effect<string, SaasBillingUnavailableError | SaasAccounts.SaasPersistenceError>;
    readonly handleWebhook: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3code-relay/saas/StripeBilling") {}

export const make = Effect.gen(function* () {
  const settings = yield* StripeConfig;
  const accounts = yield* SaasAccounts.SaasAccounts;
  const httpClient = yield* HttpClient.HttpClient;

  const requireSettings = Effect.suspend(() =>
    settings === null
      ? Effect.fail(
          new SaasBillingUnavailableError({
            code: "billing_unavailable",
            reason: "not_configured",
          }),
        )
      : Effect.succeed(settings),
  );

  const stripePost = Effect.fn("StripeBilling.post")(function* (
    config: StripeSettings,
    path: string,
    form: Record<string, string>,
  ) {
    const response = yield* httpClient.execute(
      HttpClientRequest.post(`${STRIPE_API}${path}`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(config.secretKey)}`),
        HttpClientRequest.bodyUrlParams(form),
      ),
    );
    const json = yield* response.json;
    if (response.status >= 300) {
      return yield* new StripeRequestError({ status: response.status, body: json });
    }
    return json;
  });

  const stripeError = (cause: unknown) =>
    Effect.logError("Stripe request failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new SaasBillingUnavailableError({ code: "billing_unavailable", reason: "stripe" }),
        ),
      ),
    );

  const ensureCustomer = Effect.fn("StripeBilling.ensureCustomer")(function* (
    config: StripeSettings,
    userId: string,
    email: string | null,
  ) {
    const existing = yield* accounts.getStripeCustomerId(userId);
    if (existing !== null) return existing;
    const customer = yield* stripePost(config, "/customers", {
      "metadata[user_id]": userId,
      ...(email === null ? {} : { email }),
    }).pipe(Effect.flatMap(decodeObjectId), Effect.catch(stripeError));
    yield* accounts.setStripeCustomerId({ userId, customerId: customer.id });
    return customer.id;
  });

  const createCheckout: StripeBilling["Service"]["createCheckout"] = Effect.fn(
    "StripeBilling.createCheckout",
  )(function* (input) {
    const config = yield* requireSettings;
    const plan = (yield* accounts.listPlans).find((candidate) => candidate.id === input.planId);
    if (plan === undefined) {
      return yield* new SaasNotFoundError({ code: "not_found", resource: "plan" });
    }
    if (plan.stripePriceId === null) {
      return yield* new SaasBillingUnavailableError({
        code: "billing_unavailable",
        reason: "plan_not_purchasable",
      });
    }
    const customerId = yield* ensureCustomer(config, input.userId, input.email);
    const session = yield* stripePost(config, "/checkout/sessions", {
      mode: "subscription",
      customer: customerId,
      client_reference_id: input.userId,
      "line_items[0][price]": plan.stripePriceId,
      "line_items[0][quantity]": "1",
      success_url: `${config.returnOrigin}/billing/done?status=success`,
      cancel_url: `${config.returnOrigin}/billing/done?status=cancelled`,
    }).pipe(Effect.flatMap(decodeRedirect), Effect.catch(stripeError));
    return session.url;
  });

  const createPortal: StripeBilling["Service"]["createPortal"] = Effect.fn(
    "StripeBilling.createPortal",
  )(function* (userId) {
    const config = yield* requireSettings;
    const customerId = yield* accounts.getStripeCustomerId(userId);
    if (customerId === null) {
      return yield* new SaasBillingUnavailableError({
        code: "billing_unavailable",
        reason: "no_subscription",
      });
    }
    const session = yield* stripePost(config, "/billing_portal/sessions", {
      customer: customerId,
      return_url: `${config.returnOrigin}/billing/done?status=portal`,
    }).pipe(Effect.flatMap(decodeRedirect), Effect.catch(stripeError));
    return session.url;
  });

  const applyEvent = Effect.fn("StripeBilling.applyEvent")(function* (
    event: typeof StripeEvent.Type,
  ) {
    yield* Effect.annotateCurrentSpan({ "stripe.event_type": event.type });
    if (event.type === "checkout.session.completed") {
      const session = decodeCheckoutSession(event.data.object);
      if (
        Option.isSome(session) &&
        session.value.customer !== null &&
        session.value.client_reference_id !== null
      ) {
        yield* accounts.setStripeCustomerId({
          userId: session.value.client_reference_id,
          customerId: session.value.customer,
        });
      }
      return;
    }
    if (event.type.startsWith("customer.subscription.")) {
      const subscription = decodeSubscription(event.data.object);
      if (Option.isNone(subscription)) return;
      yield* accounts.applySubscription({
        customerId: subscription.value.customer,
        subscriptionId: subscription.value.id,
        status:
          event.type === "customer.subscription.deleted" ? "canceled" : subscription.value.status,
        priceId: subscription.value.items.data[0]?.price.id ?? null,
      });
    }
  });

  const handleWebhook: StripeBilling["Service"]["handleWebhook"] = Effect.fn(
    "StripeBilling.handleWebhook",
  )(
    function* (request) {
      if (settings === null) return HttpServerResponse.empty({ status: 503 });
      const body = yield* request.text;
      const verified = yield* verifyStripeSignature({
        header: request.headers["stripe-signature"],
        body,
        secret: Redacted.value(settings.webhookSecret),
        nowSeconds: Math.floor(
          (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) / 1000,
        ),
      });
      if (!verified) return HttpServerResponse.empty({ status: 400 });
      const event = decodeEvent(body);
      if (Option.isNone(event)) return HttpServerResponse.empty({ status: 400 });
      yield* applyEvent(event.value);
      return HttpServerResponse.jsonUnsafe({ received: true });
    },
    // A 500 makes Stripe retry the event later.
    Effect.catch((error) =>
      Effect.logError("Stripe webhook failed", { error }).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  );

  return StripeBilling.of({ createCheckout, createPortal, handleWebhook });
});

export const layer = Layer.effect(StripeBilling, make).pipe(Layer.provide(FetchHttpClient.layer));

const CHECKOUT_DONE_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mira</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#ececec}main{text-align:center;max-width:28rem;padding:2rem}</style>
<main><h1>All set</h1><p>You can close this tab and return to Mira. Your plan updates within a few seconds.</p></main>
</html>`;

export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "billing",
  Effect.fnUntraced(function* (handlers) {
    const billing = yield* StripeBilling;
    return handlers
      .handleRaw("stripeWebhook", ({ request }) => billing.handleWebhook(request))
      .handleRaw("checkoutDone", () =>
        Effect.succeed(
          HttpServerResponse.text(CHECKOUT_DONE_HTML, { contentType: "text/html; charset=utf-8" }),
        ),
      );
  }),
);
