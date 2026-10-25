import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Schema from "effect/Schema";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as WriterRegistry from "./WriterRegistry.ts";

const encodeWriters = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

// An absent registry must fail deployment rather than revoke every existing writer.
export const WriterSecrets = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const configured = yield* Config.Redacted("DEVELOPER_KEYS").pipe(Config.option);
    if (Option.isSome(configured)) return ConfigProvider.fromUnknown({});
    return ConfigProvider.fromUnknown({
      DEVELOPER_KEYS: yield* encodeWriters(
        yield* WriterRegistry.WriterRegistry.pipe(
          Effect.flatMap((registry) => registry.read()),
          Effect.provide(WriterRegistry.layer.pipe(Layer.provide(NodeCrypto.layer))),
        ),
      ),
    });
  }),
);
