import { createContext, use } from "react";

export const ActiveNewTaskContext = createContext<{
  readonly pendingKey: string | null;
  /** The scoped key of the project the open draft shows, which its route may not name. */
  readonly projectKey: string | null;
} | null>(null);

export function useActiveNewTask() {
  return use(ActiveNewTaskContext);
}
