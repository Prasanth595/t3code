import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";

/**
 * Web keeps the same choice in its per-client settings. Mobile has no
 * client-settings sync, so it is stored per device alongside the other
 * composer preferences.
 */
export type FollowUpBehavior = Extract<ActiveTurnComposerAction, "queue" | "steer">;

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue";
