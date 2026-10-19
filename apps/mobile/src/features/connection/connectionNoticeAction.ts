/** Fork: the button of a connection notice. Kept free of React imports for tests. */
import {
  type EnvironmentConnectionPresentation,
  PAIRING_REVOKED_MESSAGE,
} from "@t3tools/client-runtime/connection";

export type ConnectionNoticeAction = "pair-again" | "retry" | null;

/** The button of a connection notice: pair again, retry, or none. */
export function connectionNoticeAction(
  connection: Pick<EnvironmentConnectionPresentation, "phase" | "error">,
): ConnectionNoticeAction {
  if (connection.phase === "offline" || connection.phase === "unsupported") return null;
  if (connection.phase === "error" && connection.error === PAIRING_REVOKED_MESSAGE) {
    return "pair-again";
  }
  return "retry";
}
