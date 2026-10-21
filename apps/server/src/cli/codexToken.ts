import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeCodexChatGptAuth } from "../provider/CodexChatGptAuth.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const codexTokenCommand = Command.make("__codex-token", {
  ...authLocationFlags,
  profileId: Flag.String("profile-id"),
  instanceId: Flag.String("instance-id").pipe(Flag.withSchema(ProviderInstanceId)),
}).pipe(
  Command.unlisted,
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, Option.some("None"));
      yield* Effect.gen(function* () {
        const auth = yield* makeCodexChatGptAuth({
          instanceId: flags.instanceId,
          expectedProfileId: flags.profileId,
        });
        const credentials = yield* auth.access;
        yield* Console.log(credentials.accessToken);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            ServerEnvironment.layerIdentity,
            FetchHttpClient.layer,
          ).pipe(Layer.provide(ServerConfig.layer(config))),
        ),
      );
    }).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
  ),
);

export const runCodexTokenCli = (args: ReadonlyArray<string>) =>
  Command.runWith(codexTokenCommand, { version: "0.0.0" })(args).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    NodeRuntime.runMain,
  );
