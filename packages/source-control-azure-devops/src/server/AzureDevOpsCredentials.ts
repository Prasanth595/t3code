import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

/** The Azure DevOps application ID, which `az` mints DevOps tokens for. */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const ACCOUNT_TTL = Duration.minutes(5);
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const TOKEN_FALLBACK_TTL_MS = 30 * 60_000;
const TENANT_TIMEOUT = Duration.seconds(5);
const AZ_TIMEOUT_MS = 20_000;
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const AccountsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    tenantId: Schema.String,
    user: Schema.NullOr(Schema.String),
    isDefault: Schema.Boolean,
  }),
);

const TokenSchema = Schema.Struct({
  accessToken: Schema.String,
  expiresOn: Schema.optional(Schema.NullOr(Schema.Number)),
});

export class AzureDevOpsCredentialsDecodeError extends Schema.TaggedError<AzureDevOpsCredentialsDecodeError>()(
  "AzureDevOpsCredentialsDecodeError",
  { operation: Schema.String },
) {
  // No cause: the decode error would quote the output, and an access token with it.
  override get message(): string {
    return `Azure CLI returned unexpected JSON in ${this.operation}.`;
  }
}

export interface AzureDevOpsSignIn {
  /** The `az` subscription (or tenant-level account) whose user belongs to the organization. */
  readonly subscriptionId: string;
  readonly token: Redacted.Redacted<string>;
}

export class AzureDevOpsCredentials extends Context.Service<
  AzureDevOpsCredentials,
  {
    /**
     * The `az` login that belongs to the checkout's organization, when that is not the active
     * one. Null leaves `az` to sign in its own way, which is also the answer whenever this cannot
     * tell.
     */
    readonly forCheckout: (cwd: string) => Effect.Effect<AzureDevOpsSignIn | null>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsCredentials") {}

export function azureDevOpsOrganization(remoteUrl: string): string | null {
  const key = canonicalRepositoryKey(normalizeGitRemoteUrl(remoteUrl));
  return /^dev\.azure\.com\/([^/]+)\/[^/]+\/_git\/[^/]+$/u.exec(key)?.[1] ?? null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const { process, git } = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const runAzJson = <S extends Schema.Top>(operation: string, args: Array<string>, schema: S) =>
    process
      .run({
        operation,
        command: "az",
        args: [...args, "--only-show-errors", "--output", "json"],
        cwd: workingDirectory,
        timeoutMs: AZ_TIMEOUT_MS,
      })
      .pipe(
        Effect.flatMap((output) =>
          Schema.decodeEffect(Schema.fromJsonString(schema))(output.stdout.trim()).pipe(
            Effect.mapError(() => new AzureDevOpsCredentialsDecodeError({ operation })),
          ),
        ),
      );

  const checkoutOrganization = (cwd: string) =>
    git.remotes(cwd).pipe(
      Effect.flatten,
      Effect.map(({ remotes }) => {
        const remote = remotes.find((candidate) => candidate.isPrimary) ?? remotes[0];
        return remote ? azureDevOpsOrganization(remote.url) : null;
      }),
    );

  /**
   * Every organization answers this unauthenticated, naming the Entra tenant that owns it. A
   * HEAD request, because GET is redirected to a sign-in page that drops the header.
   */
  const organizationTenant = (organization: string) =>
    httpClient
      .execute(HttpClientRequest.head(`https://dev.azure.com/${organization}/_apis/connectionData`))
      .pipe(
        Effect.timeout(TENANT_TIMEOUT),
        Effect.map((response) => {
          const tenant = response.headers["x-vss-resourcetenant"]?.trim().toLowerCase() ?? "";
          return TENANT_ID.test(tenant) && !/^[0-]+$/u.test(tenant) ? tenant : null;
        }),
      );

  const lookupAccount = Effect.fn("AzureDevOpsCredentials.lookupAccount")(function* (cwd: string) {
    const organization = yield* checkoutOrganization(cwd);
    if (organization === null) return null;
    const tenant = yield* organizationTenant(organization);
    if (tenant === null) return null;
    const accounts = yield* runAzJson(
      "AzureDevOpsCredentials.listAccounts",
      [
        "account",
        "list",
        "--all",
        "--query",
        "[].{id:id,tenantId:tenantId,user:user.name,isDefault:isDefault}",
      ],
      AccountsSchema,
    );
    const matching = accounts.filter((account) => account.tenantId.toLowerCase() === tenant);
    // The azure-devops extension tries the active login first, so it already signs in there.
    if (matching.length === 0 || matching.some((account) => account.isDefault)) return null;
    // Several people signed in to one tenant leave nothing to choose between them by.
    const users = new Set(matching.map((account) => account.user?.toLowerCase()));
    return users.size === 1 ? (matching[0]?.id ?? null) : null;
  });

  const lookupToken = Effect.fn("AzureDevOpsCredentials.lookupToken")(function* (
    subscriptionId: string,
  ) {
    const token = yield* runAzJson(
      "AzureDevOpsCredentials.getAccessToken",
      [
        "account",
        "get-access-token",
        "--resource",
        AZURE_DEVOPS_RESOURCE,
        "--subscription",
        subscriptionId,
        "--query",
        "{accessToken:accessToken,expiresOn:expires_on}",
      ],
      TokenSchema,
    );
    const now = yield* Clock.currentTimeMillis;
    const lifetimeMs =
      token.expiresOn == null
        ? TOKEN_FALLBACK_TTL_MS
        : token.expiresOn * 1000 - now - TOKEN_REFRESH_MARGIN_MS;
    return {
      token: Redacted.make(token.accessToken),
      ttl: Duration.millis(Math.max(0, lifetimeMs)),
    };
  });

  const accounts = yield* Cache.makeWith(
    (cwd: string) =>
      lookupAccount(cwd).pipe(
        Effect.tapCause((cause) =>
          Effect.logDebug("could not match an Azure CLI login to the organization", { cause }),
        ),
        Effect.orElseSucceed(() => null),
      ),
    { capacity: 64, timeToLive: () => ACCOUNT_TTL },
  );

  const tokens = yield* Cache.makeWith(lookupToken, {
    capacity: 16,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.ttl : Duration.zero),
  });

  const forCheckout: AzureDevOpsCredentials["Service"]["forCheckout"] = (cwd) =>
    // A token the user exported themselves is theirs to choose.
    environment.AZURE_DEVOPS_EXT_PAT
      ? Effect.succeed(null)
      : Cache.get(accounts, cwd).pipe(
          Effect.flatMap((subscriptionId) =>
            subscriptionId === null
              ? Effect.succeed(null)
              : Cache.get(tokens, subscriptionId).pipe(
                  Effect.map(({ token }) => ({ subscriptionId, token })),
                  Effect.tapCause((cause) =>
                    Effect.logDebug("could not get an Azure DevOps token from the Azure CLI", {
                      cause,
                    }),
                  ),
                  Effect.orElseSucceed(() => null),
                ),
          ),
        );

  return AzureDevOpsCredentials.of({ forCheckout });
});

export const layer = Layer.effect(AzureDevOpsCredentials, make);
