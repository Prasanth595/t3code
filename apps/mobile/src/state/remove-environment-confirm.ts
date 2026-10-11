import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import type { ConnectedEnvironmentSummary } from "./remote-runtime-types";

interface AlertButton {
  readonly text: string;
  readonly style?: "cancel" | "destructive";
  readonly onPress?: () => void;
}

/**
 * Presents the confirm even when the environment is missing from the connected
 * list (labelled by its id), so a stale saved row can still be forgotten.
 */
export function presentRemoveEnvironmentConfirm(input: {
  readonly environmentId: EnvironmentId;
  readonly environment:
    | Pick<ConnectedEnvironmentSummary, "environmentLabel" | "isRelayManaged">
    | undefined;
  readonly remove: (environmentId: EnvironmentId) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly openAccount: () => void;
  readonly alert: (title: string, message?: string, buttons?: AlertButton[]) => void;
}): void {
  const { alert, environment, environmentId } = input;
  const label = environment?.environmentLabel.trim() || environmentId;
  const remove = {
    text: "Remove",
    style: "destructive",
    onPress: () => {
      void input.remove(environmentId).then((result) => {
        if (AsyncResult.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) return;
        const error = Cause.squash(result.cause);
        alert(
          "Could not remove environment",
          error instanceof Error ? error.message : "The environment could not be removed.",
        );
      });
    },
  } as const;
  if (environment?.isRelayManaged) {
    alert(
      "Remove from this device?",
      `Forget ${label} and its cached threads on this device.\n\nIt stays on your T3 Connect account and keeps its host space. Deregister it under T3 Account → T3 Connect to free it.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open T3 Account", onPress: input.openAccount },
        remove,
      ],
    );
    return;
  }
  alert(
    "Remove from this device?",
    `Forget ${label} and its cached threads on this device. Switch it off instead to keep it saved.`,
    [{ text: "Cancel", style: "cancel" }, remove],
  );
}
