import { useFocusEffect } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";
import { appAtomRegistry } from "./atom-registry";

// A focused new-task flow replaces the thread selection, even before it has a draft row.
export const activeNewTaskAtom = Atom.make<{ readonly pendingKey: string | null } | null>(
  null,
).pipe(Atom.keepAlive);

export function useActiveNewTask(pendingKey: string | null) {
  useFocusEffect(
    useCallback(() => {
      appAtomRegistry.set(activeNewTaskAtom, { pendingKey });
      return () => appAtomRegistry.set(activeNewTaskAtom, null);
    }, [pendingKey]),
  );
}
