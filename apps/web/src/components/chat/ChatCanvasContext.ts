import { createContext, useContext } from "react";
import type { resolveChatCanvasLayout } from "./chatCanvasLayout";
import type {
  resolveThreadDetailsCardLayout,
  resolveUsageCardLayout,
} from "./threadDetailsCardLayout";
import type { DetailsCardHeight } from "./canvasStore";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** The inline details card's measured full-density height at a card width. */
export interface DetailsCardMeasurement {
  readonly threadRef: ScopedThreadRef;
  readonly width: number;
  readonly fullContentHeight: number;
}

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  previewKey: string | null;
  registerTimeline: (element: HTMLElement | null) => void;
  measureDetailsCard: (measurement: DetailsCardMeasurement) => void;
  measureDetailsCardHeight: (measurement: DetailsCardHeight) => void;
  measureUsageCard: (height: number) => void;
  detailsCardTopInset: number;
  /** Where an inline card sits when nothing overlaps it; null when the canvas is too narrow. */
  preferredDetailsCard: ReturnType<typeof resolveThreadDetailsCardLayout>;
  /** Where the inline card sits now; null when it shows as a popover. */
  detailsCardPlacement: ReturnType<typeof resolveThreadDetailsCardLayout>;
  /** Where the inline usage card sits under the details card; null when it shows as a popover. */
  usageCardPlacement: ReturnType<typeof resolveUsageCardLayout>;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
