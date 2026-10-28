import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface WatchBridge {
  readonly isEnabled: boolean;
  listRecordings(): Promise<unknown>;
  removeRecording(id: string): Promise<void>;
  publishSnapshot(json: string): Promise<void>;
  listPendingActions?(): Promise<unknown>;
  removeAction?(id: string): Promise<void>;
  addListener(event: "onRecordingsChanged", listener: () => void): { remove(): void };
  addListener(event: "onAction", listener: (action: unknown) => void): { remove(): void };
}

const nativeBridge =
  Platform.OS === "ios" ? requireOptionalNativeModule<WatchBridge>("T3WatchBridge") : null;

export const watchBridge = nativeBridge?.isEnabled === true ? nativeBridge : null;

export const supportsDurableWatchActions =
  typeof watchBridge?.listPendingActions === "function" &&
  typeof watchBridge?.removeAction === "function";
