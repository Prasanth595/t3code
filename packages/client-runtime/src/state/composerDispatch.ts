export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  // A /compact or /logout run cannot take a steer, so every follow-up queues behind it.
  readonly activeTurnIsMaintenance?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.activeTurnIsMaintenance) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
  activeTurnIsMaintenance?: boolean,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
    ...(activeTurnIsMaintenance === undefined ? {} : { activeTurnIsMaintenance }),
  }) as ActiveTurnComposerAction;
}
