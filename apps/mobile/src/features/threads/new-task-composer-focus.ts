// Kept out of route params so a restored draft URL never reopens the keyboard; request ids are unique per new task.
let focusedRequestId: string | null = null;

export function requestNewTaskComposerFocus(requestId: string): void {
  focusedRequestId = requestId;
}

export function isNewTaskComposerFocusRequested(requestId: string | undefined): boolean {
  return requestId !== undefined && requestId === focusedRequestId;
}
