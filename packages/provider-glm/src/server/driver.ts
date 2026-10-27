import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makeAcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { GlmSettings } from "../settings.ts";
import { readGlmPromptFailure } from "./promptFailure.ts";
import { readGlmUsageLimits } from "./usageLimits.ts";

export type GlmDriverEnv =
  | AcpRegistryDriverEnv
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient;

const driverKind = ProviderDriverKind.make("glm");
const decodeSettings = Schema.decodeUnknownSync(GlmSettings);

export const GlmDriver: ProviderDriver<GlmSettings, GlmDriverEnv> = {
  driverKind,
  metadata: {
    displayName: "GLM Agent",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: GlmSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("GlmDriver.create")(function* (input) {
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const hostEnvironment = yield* HostProcess.Environment;
    const client = yield* HttpClient.HttpClient;
    return yield* makeAcpRegistryDriver({
      driverKind,
      displayName: "GLM Agent",
      // Keep imported native item IDs stable across the ACP Registry migration.
      itemIdentityDriver: ProviderDriverKind.make("acpRegistry"),
      resolvePromptFailure: (cause, environment) =>
        readGlmPromptFailure({ cause, environment }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      readUsageLimits: (environment) =>
        readGlmUsageLimits({ enabled: input.enabled, environment }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HttpClient.HttpClient, client),
        ),
    })
      .create(input)
      .pipe(
        Effect.provideService(HostProcess.Environment, {
          ...hostEnvironment,
          Z_AI_API_KEY: undefined,
        }),
      );
  }),
};
