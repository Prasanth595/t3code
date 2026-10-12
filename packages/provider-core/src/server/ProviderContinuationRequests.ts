import {
  type ModelSelection,
  type OrchestrationV2Notification,
  type OrchestrationV2NativeCause,
  type OrchestrationV2ExecutionDelivery,
  type OrchestrationV2NativeAcceptance,
  type OrchestrationV2NativeRunCauseSource,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
  OrchestrationV2RunCauseSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { ProviderAdapterV2TurnInput } from "./ProviderAdapter.ts";

export const sourceKey = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2RunCauseSource));

interface ContinuationContent {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
}

export type ProviderContinuationRequest = ContinuationContent &
  (
    | {
        readonly kind: "delegated_completion";
        readonly delegatedCompletion: {
          readonly parentRunId: RunId;
          readonly generation: number;
          readonly messageId: MessageId;
        };
        readonly delivery: { readonly kind: "message_text" };
      }
    | {
        readonly kind: "native";
        readonly messageId: MessageId;
        readonly cause: OrchestrationV2NativeCause;
        readonly delivery: OrchestrationV2ExecutionDelivery;
        readonly isCurrent: Effect.Effect<boolean>;
        readonly clearIfCurrent?: () => Effect.Effect<void>;
      }
  );

export interface NativeAcceptedExecution {
  readonly source: OrchestrationV2NativeRunCauseSource;
  readonly modelSelection: ModelSelection;
  readonly receipt: OrchestrationV2NativeAcceptance;
}

export class NativeExecutionIncarnation {
  private ordinaryOnly: boolean;
  private process: NativeAcceptedExecution | undefined;
  readonly identity: string;
  constructor(identity: string, restored: boolean) {
    this.identity = identity;
    this.ordinaryOnly = !restored;
  }

  accept(input: ProviderAdapterV2TurnInput, nativeThreadId: string): NativeAcceptedExecution {
    if (input.executionScope.kind !== "ordinary") this.ordinaryOnly = false;
    const source: OrchestrationV2NativeRunCauseSource = {
      kind: "native",
      threadId: input.threadId,
      runId: input.runId,
      attemptId: input.attemptId,
      providerInstanceId: input.modelSelection.instanceId,
      providerThreadId: input.providerThread.id,
      nativeThreadId,
      incarnation: this.identity,
    };
    const policyAttemptId =
      input.executionDelivery.kind === "adapter_buffered"
        ? input.executionDelivery.process.attemptId
        : input.attemptId;
    const accepted = {
      source,
      modelSelection: input.modelSelection,
      receipt: {
        incarnation: this.identity,
        onlyOrdinary: this.ordinaryOnly,
        policyAttemptId,
        acceptedAttemptId: input.attemptId,
      },
    };
    if (input.executionDelivery.kind !== "adapter_buffered") this.process = accepted;
    return accepted;
  }

  incomplete(
    knownSources: ReadonlyArray<OrchestrationV2NativeRunCauseSource> = [],
  ): OrchestrationV2NativeCause {
    return {
      kind: "incomplete",
      knownSources,
      ordinaryProcess: this.ordinaryOnly ? (this.process?.source ?? null) : null,
    };
  }

  buffered(
    bufferId: string,
    bounds: Extract<OrchestrationV2ExecutionDelivery, { kind: "adapter_buffered" }>["bounds"],
  ): OrchestrationV2ExecutionDelivery | null {
    if (this.process === undefined) return null;
    return {
      kind: "adapter_buffered",
      bufferId,
      process: this.process.source,
      modelSelection: this.process.modelSelection,
      bounds,
    };
  }

  invalidate(): void {
    this.ordinaryOnly = false;
  }
}

export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    return {
      offer: (request: ProviderContinuationRequest) =>
        Queue.offer(queue, request).pipe(Effect.asVoid),
      take: Queue.take(queue),
    };
  }),
);
