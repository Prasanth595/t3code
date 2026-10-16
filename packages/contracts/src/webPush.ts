/**
 * Fork: Web Push from a T3 server to the browsers that subscribed on it. The server sends a push
 * when one of its threads needs attention, so a phone gets the notification while the app is closed.
 */
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The parts of a browser `PushSubscription` that the server needs. Keys are base64url. */
export const WebPushSubscription = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  p256dh: TrimmedNonEmptyString,
  auth: TrimmedNonEmptyString,
});
export type WebPushSubscription = typeof WebPushSubscription.Type;

export const WebPushSubscribeInput = Schema.Struct({
  subscription: WebPushSubscription,
  /** The origin of the page that subscribed. The VAPID JWT names it as the sender contact. */
  origin: TrimmedNonEmptyString,
});
export type WebPushSubscribeInput = typeof WebPushSubscribeInput.Type;

export const WebPushEndpointInput = Schema.Struct({ endpoint: TrimmedNonEmptyString });
export type WebPushEndpointInput = typeof WebPushEndpointInput.Type;

/** The VAPID public key of this server, an uncompressed P-256 point as base64url. */
export const WebPushPublicKey = Schema.Struct({ publicKey: TrimmedNonEmptyString });
export type WebPushPublicKey = typeof WebPushPublicKey.Type;

/** `gone` means that the push service no longer knows the subscription. The server removed it. */
export const WebPushTestResult = Schema.Struct({
  result: Schema.Literals(["delivered", "gone", "unknown-subscription"]),
});
export type WebPushTestResult = typeof WebPushTestResult.Type;

/** The JSON body of each push. `apps/web/public/sw.js` reads it. */
export interface WebPushMessage {
  readonly title: string;
  readonly body: string;
  /** The same tag as the page notification of the thread, so one replaces the other. */
  readonly tag: string;
  /** A path of the web app, for example `/<environmentId>/<threadId>`. */
  readonly url: string;
}

export class WebPushError extends Schema.TaggedError<WebPushError>()("WebPushError", {
  operation: Schema.Literals(["read-key", "save-subscriptions", "send"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Web Push could not ${this.operation.replace("-", " ")}: ${this.detail}`;
  }
}
