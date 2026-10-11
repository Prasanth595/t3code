import type { EnvironmentId, ProjectEntry, ThreadId } from "@t3tools/contracts";
import {
  type ComposerThreadCandidate,
  matchComposerThreadItems,
} from "@t3tools/client-runtime/composerThreadItems";

import { basenameOfPath } from "../../pierre-icons";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

/**
 * Items for the `@` picker. Threads only surface for a typed query so `@` alone stays a file
 * picker. A title match is far more specific than a fuzzy path hit, so the few threads lead
 * the list. An answer to a question carries text and files but no thread context, so threads
 * are left out while the composer is answering one.
 */
export function composerPathMenuItems(input: {
  threadShells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  query: string;
  entries: ReadonlyArray<{ path: string; kind: ProjectEntry["kind"] }>;
  answeringQuestion: boolean;
}): ComposerCommandItem[] {
  const threadItems = input.answeringQuestion
    ? []
    : matchComposerThreadItems({
        shells: input.threadShells,
        environmentId: input.environmentId,
        excludeThreadId: input.activeThreadId,
        query: input.query,
      });
  return [
    ...threadItems,
    ...input.entries.map((entry) => ({
      id: `path:${entry.kind}:${entry.path}`,
      type: "path" as const,
      path: entry.path,
      pathKind: entry.kind,
      label: basenameOfPath(entry.path),
      description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
    })),
  ];
}
