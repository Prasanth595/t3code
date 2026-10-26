// @effect-diagnostics-next-line nodeBuiltinImport:off -- signs fixtures the way Stripe does.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestClock from "effect/testing/TestClock";

import * as SaasAccounts from "./SaasAccounts.ts";
import * as StripeBilling from "./StripeBilling.ts";

const secret = "whsec_test";
const sign = (timestamp: number, body: string) =>
  `t=${timestamp},v1=${NodeCrypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

describe("verifyStripeSignature", () => {
  const body = '{"type":"ping"}';
  it.effect("accepts Stripe's signature and rejects tampered or stale ones", () =>
    Effect.gen(function* () {
      const verify = (header: string, nowSeconds = 1_000, payload = body) =>
        StripeBilling.verifyStripeSignature({ header, body: payload, secret, nowSeconds });
      expect(yield* verify(sign(1_000, body))).toBe(true);
      expect(yield* verify(sign(1_000, body), 1_000, '{"type":"pong"}')).toBe(false);
      expect(yield* verify(sign(1_000, body), 1_000 + 301)).toBe(false);
      expect(yield* verify("t=1000")).toBe(false);
    }),
  );
});

describe("StripeBilling webhook", () => {
  it.effect("moves the account to the plan bought, and back when the subscription ends", () =>
    Effect.gen(function* () {
      const applied: Array<{ status: string; priceId: string | null; customerId: string }> = [];
      const layer = StripeBilling.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(StripeBilling.StripeConfig, {
              secretKey: Redacted.make("sk_test"),
              webhookSecret: Redacted.make(secret),
              returnOrigin: "https://relay.test",
            }),
            Layer.mock(SaasAccounts.SaasAccounts, {
              applySubscription: (input) =>
                Effect.sync(() => {
                  applied.push({
                    status: input.status,
                    priceId: input.priceId,
                    customerId: input.customerId,
                  });
                }),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("no Stripe calls")),
            ),
          ),
        ),
      );
      yield* TestClock.setTime(2_000_000);
      const deliver = (type: string, status: string) => {
        const body = JSON.stringify({
          type,
          data: {
            object: {
              id: "sub_1",
              customer: "cus_1",
              status,
              items: { data: [{ price: { id: "price_pro" } }] },
            },
          },
        });
        return StripeBilling.StripeBilling.pipe(
          Effect.flatMap((billing) =>
            billing.handleWebhook(
              HttpServerRequest.fromWeb(
                new Request("https://relay.test/v1/billing/stripe-webhook", {
                  method: "POST",
                  headers: { "stripe-signature": sign(2_000, body) },
                  body,
                }),
              ),
            ),
          ),
          Effect.provide(layer),
        );
      };
      expect((yield* deliver("customer.subscription.updated", "active")).status).toBe(200);
      expect((yield* deliver("customer.subscription.deleted", "active")).status).toBe(200);
      expect(applied).toEqual([
        { status: "active", priceId: "price_pro", customerId: "cus_1" },
        { status: "canceled", priceId: "price_pro", customerId: "cus_1" },
      ]);
    }),
  );
});
