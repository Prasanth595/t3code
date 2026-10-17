import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { MissionPeerRuntimeFactsError } from "./MissionPeerRuntimeFacts.ts";

const BootUuid = Schema.String.check(Schema.isUUID(4));

export class MissionPeerBootIdentity extends Context.Service<
  MissionPeerBootIdentity,
  { readonly read: Effect.Effect<string, MissionPeerRuntimeFactsError> }
>()("t3/orchestration-v2/MissionPeerBootIdentity") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const read = Effect.gen(function* () {
    let raw: string;
    if (platform === "linux") {
      raw = yield* fs.readFileString("/proc/sys/kernel/random/boot_id").pipe(
        Effect.mapError((cause) => new MissionPeerRuntimeFactsError({ category: "read", cause })),
      );
    } else if (platform === "darwin") {
      const result = yield* runner
        .run({
          command: "/usr/sbin/sysctl",
          args: ["-n", "kern.bootsessionuuid"],
          timeout: "5 seconds",
          maxOutputBytes: 256,
          outputMode: "error",
        })
        .pipe(
          Effect.mapError((cause) => new MissionPeerRuntimeFactsError({ category: "read", cause })),
        );
      if (
        result.code !== 0 ||
        result.timedOut ||
        result.stdoutTruncated ||
        result.stderrTruncated ||
        result.stdoutInvalidUtf8 ||
        result.stderrInvalidUtf8
      ) {
        return yield* new MissionPeerRuntimeFactsError({ category: "read" });
      }
      raw = result.stdout;
    } else {
      return yield* new MissionPeerRuntimeFactsError({ category: "unavailable" });
    }
    const uuid = yield* Schema.decodeUnknownEffect(BootUuid)(raw.trim().toLowerCase()).pipe(
      Effect.mapError(() => new MissionPeerRuntimeFactsError({ category: "read" })),
    );
    return `${platform}:${uuid}`;
  });
  return MissionPeerBootIdentity.of({ read });
});

export const layer = Layer.effect(MissionPeerBootIdentity, make);
