import type {
  AuthClientMetadata,
  ClientSurface,
  OrchestrationV2MessageSender,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as NodeDnsPromises from "node:dns/promises";

import { readRemoteAddressFromSource } from "./utils.ts";

const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "cf-connecting-ip"];

/**
 * The device a socket's messages come from. A loopback peer counts as this machine only when
 * no proxy fronts it: T3 Connect's tunnel and `tailscale serve` also connect over loopback.
 */
export function messageSenderFromConnection(input: {
  readonly client: AuthClientMetadata;
  readonly surface?: ClientSurface | undefined;
  readonly remoteAddress: string | undefined;
  readonly proxied: boolean;
}): OrchestrationV2MessageSender {
  const address = input.remoteAddress;
  const loopback = address !== undefined && (address === "::1" || address.startsWith("127."));
  return {
    ...(input.client.label === undefined ? {} : { label: input.client.label }),
    deviceType: input.client.deviceType,
    ...(input.client.os === undefined ? {} : { os: input.client.os }),
    ...(input.surface === undefined ? {} : { surface: input.surface }),
    sameMachine: loopback && !input.proxied,
  };
}

export const resolveMessageSender = Effect.fn("resolveMessageSender")(function* (
  request: HttpServerRequest.HttpServerRequest,
  client: AuthClientMetadata,
  surface: ClientSurface | undefined,
) {
  const remoteAddress = readRemoteAddressFromSource(request.source);
  const proxied = PROXY_HEADERS.some((header) => request.headers[header] !== undefined);
  const sender = messageSenderFromConnection({ client, surface, remoteAddress, proxied });
  if (sender.sameMachine || proxied || remoteAddress === undefined) return sender;
  // Bounded because it delays the socket upgrade; an unresolved address just omits the name.
  const hostName = yield* Effect.tryPromise(() => NodeDnsPromises.reverse(remoteAddress)).pipe(
    Effect.timeoutOption("300 millis"),
    Effect.map((names) => Option.getOrUndefined(names)?.[0]?.replace(/\.$/, "")),
    Effect.orElseSucceed(() => undefined),
  );
  return hostName ? { ...sender, hostName } : sender;
});
