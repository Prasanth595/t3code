export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  // A /compact run cannot take a steer, so every follow-up queues behind it.
  readonly activeTurnIsCompaction?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.activeTurnIsCompaction) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
  activeTurnIsCompaction?: boolean,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
    ...(activeTurnIsCompaction === undefined ? {} : { activeTurnIsCompaction }),
  }) as ActiveTurnComposerAction;
}
