import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
): UserMessageIntentBadgePresentation | null {
  switch (intent) {
    case "steer":
      return {
        label: "Redirecționat",
        accessibilityLabel: "A redirecționat runda activă",
      };
    case "promoted_queued_to_steer":
      return {
        label: "Redirecționat",
        accessibilityLabel: "Pus inițial în coadă, apoi folosit ca să redirecționeze runda activă",
      };
    case "queued_turn":
    case "turn_start":
    case undefined:
      return null;
  }
}
