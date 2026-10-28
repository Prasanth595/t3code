import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SharedObservability from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";
import * as Option from "effect/Option";

import * as TemporaryThreadDiagnostics from "./observability/TemporaryThreadDiagnostics.ts";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpLogger from "effect/observability/OtlpLogger";

import * as ServerConfig from "./config.ts";

// consolePretty collapses Cause fields via util.inspect; render them with Cause.pretty like standalone arguments.
const consolePretty = (): Logger.Logger<unknown, void> => {
  const pretty = Logger.consolePretty();
  return Logger.make((options) =>
    pretty.log({
      ...options,
      message: Array.isArray(options.message)
        ? options.message.map(prettyCauseFields)
        : prettyCauseFields(options.message),
    }),
  );
};

function prettyCauseFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  // A message with its own redaction hook already decides how it prints.
  if (Redactable.isRedactable(value)) return value;
  // Copy descriptors to preserve symbols without invoking getters.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor && Cause.isCause(descriptor.value)) {
      descriptor.value = Cause.pretty(descriptor.value);
      changed = true;
    }
  }
  return changed ? Object.create(prototype, descriptors) : value;
}

export const layer = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const diagnostics = yield* Effect.serviceOption(
    TemporaryThreadDiagnostics.TemporaryThreadDiagnostics,
  );
  const protect = (logger: Logger.Logger<unknown, void>) =>
    Logger.make<unknown, void>((options) => {
      if (Option.isSome(diagnostics) && !diagnostics.value.canRecord()) {
        const message = TemporaryThreadDiagnostics.operationalLogMessages.get(options.logLevel);
        if (message === undefined || !diagnostics.value.canRecordOperational()) return;
        const context = options.fiber.context.pipe(
          Context.add(References.CurrentLogAnnotations, {}),
          Context.add(References.CurrentLogSpans, []),
        );
        logger.log({
          ...options,
          message: [message],
          cause: Cause.empty,
          fiber: {
            ...options.fiber,
            getRef: (reference) => Context.get(context, reference),
          },
        });
        return;
      }
      logger.log(options);
    });
  const hostName = yield* HostProcess.Hostname;
  const layerMinimumLogLevel = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  const logs = config.otlpLogsExport;
  const otlpLogger =
    config.otlpLogsUrl === undefined
      ? undefined
      : OtlpLogger.make({
          url: config.otlpLogsUrl,
          exportInterval: `${logs.exportIntervalMs} millis`,
          headers: logs.headers,
          resource: ServerConfig.otlpResource(config, hostName),
        });

  // Logger.layer replaces the whole set; name every logger here.
  // OTLP includes traced messages as log records, so also using tracerLogger would duplicate in-span exports.
  const layerLogger = Logger.layer(
    otlpLogger === undefined
      ? [protect(consolePretty()), protect(Logger.tracerLogger)]
      : [protect(consolePretty()), Effect.map(otlpLogger, protect)],
    { mergeWithExisting: false },
  ).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(SharedObservability.layerOtlpSerialization(logs.protocol)),
  );

  return Layer.mergeAll(layerLogger, layerMinimumLogLevel);
}).pipe(Layer.unwrap);
