import { ManagedRelay, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type {
  ProviderInstanceConfig,
  ProviderInstanceEnvironment,
  ServerSettings,
} from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { SaasAccountResponse, SaasLlmKeyResponse } from "@t3tools/contracts/saas";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";
import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

// The paid plan Upgrade buys; admins set its Stripe price in the admin page.
export const MIRA_UPGRADE_PLAN_ID = "pro";

const MIRA_BASE_URL_ENV = "MIRA_BASE_URL";
const MIRA_API_KEY_ENV = "MIRA_API_KEY";
export const MIRA_PI_INSTANCE_ID = ProviderInstanceId.make("pi");

async function withRelay<A>(
  request: (
    client: ManagedRelay.ManagedRelayClient["Service"],
    clerkToken: string,
  ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
): Promise<A> {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  return runtime.runPromise(
    Effect.gen(function* () {
      const clerkToken = session ? yield* session.readClerkToken() : null;
      if (!clerkToken) {
        return yield* Effect.die(new Error("Sign in to your Mira account first."));
      }
      const client = yield* ManagedRelay.ManagedRelayClient;
      return yield* request(client, clerkToken);
    }),
  );
}

export const fetchMiraAccount = (): Promise<SaasAccountResponse> =>
  withRelay((client, clerkToken) => client.getAccount({ clerkToken }));

export const issueMiraModelKey = (): Promise<SaasLlmKeyResponse> =>
  withRelay((client, clerkToken) => client.createLlmKey({ clerkToken }));

export async function openMiraCheckout(planId: string): Promise<void> {
  const { url } = await withRelay((client, clerkToken) =>
    client.createCheckout({ clerkToken, planId }),
  );
  await ensureLocalApi().shell.openExternal(url);
}

export async function openMiraBillingPortal(): Promise<void> {
  const { url } = await withRelay((client, clerkToken) =>
    client.createBillingPortal({ clerkToken }),
  );
  await ensureLocalApi().shell.openExternal(url);
}

/** Replaces any earlier Mira variables and keeps the user's other variables. */
export function withMiraEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  key: Pick<SaasLlmKeyResponse, "apiKey" | "baseUrl">,
): ProviderInstanceEnvironment {
  return [
    ...(environment ?? []).filter(
      (variable) => variable.name !== MIRA_BASE_URL_ENV && variable.name !== MIRA_API_KEY_ENV,
    ),
    { name: MIRA_BASE_URL_ENV, value: key.baseUrl, sensitive: false },
    { name: MIRA_API_KEY_ENV, value: key.apiKey, sensitive: true },
  ];
}

export function hasMiraEnvironment(settings: Pick<ServerSettings, "providerInstances">): boolean {
  const environment = settings.providerInstances[MIRA_PI_INSTANCE_ID]?.environment ?? [];
  return [MIRA_BASE_URL_ENV, MIRA_API_KEY_ENV].every((name) =>
    environment.some(
      (variable) => variable.name === name && (variable.value !== "" || variable.valueRedacted),
    ),
  );
}

/** The Pi instance upsert that points its sessions at the account's model. */
export function miraPiInstance(
  settings: Pick<ServerSettings, "providerInstances">,
  key: Pick<SaasLlmKeyResponse, "apiKey" | "baseUrl">,
): ProviderInstanceConfig {
  const current = settings.providerInstances[MIRA_PI_INSTANCE_ID];
  return {
    ...current,
    driver: current?.driver ?? ProviderDriverKind.make("pi"),
    enabled: true,
    environment: withMiraEnvironment(current?.environment, key),
  };
}

export const formatMiraTokens = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`
    : tokens.toLocaleString("en-US");
