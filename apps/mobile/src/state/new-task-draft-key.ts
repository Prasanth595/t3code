const NEW_TASK_DRAFT_PREFIX = "new-task:";

export function newTaskDraftKey(draftId: string): string {
  return `${NEW_TASK_DRAFT_PREFIX}${draftId}`;
}

export function isNewTaskDraftKey(draftKey: string): boolean {
  return draftKey.startsWith(NEW_TASK_DRAFT_PREFIX);
}

/**
 * The outbox drain writes it and the thread screen's "Edit task" action opens
 * it, so both sides derive the key here rather than rebuilding the string.
 */
export function restoredNewTaskDraftKey(messageId: string): string {
  return newTaskDraftKey(`restored-${messageId}`);
}

/**
 * Ids are UUIDs and never contain a colon, so a colon after the prefix marks
 * the legacy shape.
 */
export function parseLegacyNewTaskDraftKey(
  draftKey: string,
): { readonly environmentId: string; readonly projectId: string } | null {
  if (!isNewTaskDraftKey(draftKey)) {
    return null;
  }
  const scope = draftKey.slice(NEW_TASK_DRAFT_PREFIX.length);
  const separator = scope.lastIndexOf(":");
  if (separator <= 0 || separator === scope.length - 1) {
    return null;
  }
  return { environmentId: scope.slice(0, separator), projectId: scope.slice(separator + 1) };
}
