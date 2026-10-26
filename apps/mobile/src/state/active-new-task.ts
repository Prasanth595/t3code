import { Atom } from "effect/reactivity";
import { createContext, use } from "react";

export const ActiveNewTaskContext = createContext<{ readonly pendingKey: string | null } | null>(
  null,
);

export function useActiveNewTask() {
  return use(ActiveNewTaskContext);
}

/**
 * The scoped key of the project the open draft shows, which its route may not name. Read it when
 * needed rather than subscribing, so draft changes don't re-render readers.
 */
export const activeNewTaskProjectKeyAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);
