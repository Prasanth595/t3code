import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCredentials from "./AzureDevOpsCredentials.ts";

const ORG_TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REMOTE = "https://acme@dev.azure.com/acme/Platform%20Team/_git/web-app";

interface Account {
  readonly id: string;
  readonly tenantId: string;
  readonly user: string;
  readonly isDefault: boolean;
}

function harness(input: { readonly accounts: ReadonlyArray<Account>; readonly env?: object }) {
  const azCalls: Array<ReadonlyArray<string>> = [];
  const tenantRequests: Array<string> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (process) => {
    azCalls.push(process.args);
    if (process.args[1] === "list") {
      return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(input.accounts)));
    }
    if (process.args[1] === "get-access-token") {
      const subscription = process.args[process.args.indexOf("--subscription") + 1];
      return Effect.succeed(
        TestSourceControlHost.processOutput(
          JSON.stringify({ accessToken: `token-for-${subscription}`, expiresOn: 4_102_444_800 }),
        ),
      );
    }
    return Effect.die(`unexpected az ${process.args.join(" ")}`);
  };
  const layer = AzureDevOpsCredentials.layer.pipe(
    Layer.provide(
      TestSourceControlHost.layer({
        process: { run },
        git: {
          remotes: () =>
            Effect.succeed(
              Effect.succeed({
                remotes: [{ name: "origin", url: REMOTE, pushUrl: Option.none(), isPrimary: true }],
                freshness: {
                  source: "live-local" as const,
                  observedAt: DateTime.makeUnsafe(0),
                  expiresAt: Option.none(),
                },
              }),
            ),
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          tenantRequests.push(`${request.method} ${request.url}`);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 405, headers: { "x-vss-resourcetenant": ORG_TENANT } }),
            ),
          );
        }),
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Environment, { ...input.env })),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
  );
  return { layer, azCalls, tenantRequests };
}

describe("AzureDevOpsCredentials", () => {
  it("reads the organization from every Azure DevOps remote spelling", () => {
    for (const url of [
      REMOTE,
      "git@ssh.dev.azure.com:v3/acme/Platform%20Team/web-app",
      "https://acme.visualstudio.com/DefaultCollection/Platform%20Team/_git/web-app",
    ]) {
      assert.strictEqual(AzureDevOpsCredentials.azureDevOpsOrganization(url), "acme");
    }
    assert.isNull(AzureDevOpsCredentials.azureDevOpsOrganization("https://github.com/acme/repo"));
  });

  it.effect("signs in with the login in the organization's tenant, not the active one", () => {
    const { layer, azCalls, tenantRequests } = harness({
      accounts: [
        { id: "active-sub", tenantId: OTHER_TENANT, user: "me@other.com", isDefault: true },
        { id: ORG_TENANT, tenantId: ORG_TENANT, user: "me@acme.com", isDefault: false },
      ],
    });
    return Effect.gen(function* () {
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      const first = yield* credentials.forCheckout("/repo");
      const second = yield* credentials.forCheckout("/repo");

      assert.strictEqual(first?.subscriptionId, ORG_TENANT);
      assert.strictEqual(first && Redacted.value(first.token), `token-for-${ORG_TENANT}`);
      assert.strictEqual(second?.subscriptionId, ORG_TENANT);
      assert.deepStrictEqual(tenantRequests, [
        "HEAD https://dev.azure.com/acme/_apis/connectionData",
      ]);
      // Both the account match and the token are reused rather than re-running `az`.
      assert.deepStrictEqual(
        azCalls.map((args) => args[1]),
        ["list", "get-access-token"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves az alone when the active login already belongs to the tenant", () => {
    const { layer, azCalls } = harness({
      accounts: [
        { id: "active-sub", tenantId: ORG_TENANT, user: "me@acme.com", isDefault: true },
        { id: "other-sub", tenantId: ORG_TENANT, user: "me@acme.com", isDefault: false },
      ],
    });
    return Effect.gen(function* () {
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      assert.isNull(yield* credentials.forCheckout("/repo"));
      assert.deepStrictEqual(
        azCalls.map((args) => args[1]),
        ["list"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not guess between two people signed in to the same tenant", () => {
    const { layer } = harness({
      accounts: [
        { id: "active-sub", tenantId: OTHER_TENANT, user: "me@other.com", isDefault: true },
        { id: "sub-a", tenantId: ORG_TENANT, user: "a@acme.com", isDefault: false },
        { id: "sub-b", tenantId: ORG_TENANT, user: "b@acme.com", isDefault: false },
      ],
    });
    return Effect.gen(function* () {
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      assert.isNull(yield* credentials.forCheckout("/repo"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a token the user exported themselves", () => {
    const { layer, azCalls, tenantRequests } = harness({
      accounts: [{ id: ORG_TENANT, tenantId: ORG_TENANT, user: "me@acme.com", isDefault: false }],
      env: { AZURE_DEVOPS_EXT_PAT: "their-pat" },
    });
    return Effect.gen(function* () {
      const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
      assert.isNull(yield* credentials.forCheckout("/repo"));
      assert.deepStrictEqual(azCalls, []);
      assert.deepStrictEqual(tenantRequests, []);
    }).pipe(Effect.provide(layer));
  });
});
