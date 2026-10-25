import * as Layer from "effect/Layer";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as NativeSessionStore from "./NativeSessionStore.ts";
import * as EventStore from "./EventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
export const layerCommandReceiptStoreProvided =
  CommandReceiptStore.layerFromApplicationReceipts.pipe(Layer.provide(layerEventInfrastructure));

export const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));
export const layerNativeSessionStore = NativeSessionStore.layer.pipe(Layer.provide(layerEventSink));
