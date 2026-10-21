import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderCredentialStore from "../provider/ProviderCredentialStore.ts";
import { codexTokenCommand } from "./codexToken.ts";

it.effect(
  "the Codex token helper reads rotated credentials, rejects profile replacement, and stops after sign-out",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const instanceId = ProviderInstanceId.make("helper-account");
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
      const run = Command.runWith(codexTokenCommand, { version: "0.0.0" })([
        "--base-dir",
        config.baseDir,
        "--instance-id",
        instanceId,
        "--profile-id",
        "oaiapp_helper",
      ]);
      for (const accessToken of ["initial-access", "renewed-access"]) {
        yield* store.set(
          new TextEncoder().encode(
            JSON.stringify({
              clientId: "oaiapp_helper",
              accessToken,
              refreshToken: "dummy-refresh",
              expiresAt: Number.MAX_SAFE_INTEGER,
              earliestRefreshAt: null,
              scopes: ["chatgpt.tokens.use.direct"],
              subject: "test-user",
              email: null,
            }),
          ),
        );
        yield* run;
      }
      yield* store.set(
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "oaiapp_replacement",
            accessToken: "replacement-account-access",
            refreshToken: null,
            expiresAt: 0,
            earliestRefreshAt: null,
            scopes: ["chatgpt.tokens.use.direct"],
            subject: "another-user",
            email: null,
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(run)));
      assert.isTrue((yield* store.get)._tag === "Some");
      yield* store.remove;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(run)));
      assert.deepEqual(yield* TestConsole.logLines, ["initial-access", "renewed-access"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerSecretStore.layer,
          NetService.layer,
          TestConsole.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-token-helper-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
