export function startSidebarTouchHold(
  row: HTMLElement,
  pointer: PointerEvent,
  onHold: (position: { x: number; y: number }) => void,
): () => void {
  const document = row.ownerDocument;
  const gesture = new AbortController();
  const clickSuppression = new AbortController();
  const options = { capture: true, signal: gesture.signal };
  const finish = () => {
    clearTimeout(timer);
    gesture.abort();
  };
  const timer = setTimeout(() => {
    // Touch browsers can synthesize a click on release even after the menu opens.
    document.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        clickSuppression.abort();
      },
      { capture: true, once: true, signal: clickSuppression.signal },
    );
    document.addEventListener("pointerdown", () => clickSuppression.abort(), {
      capture: true,
      once: true,
      signal: clickSuppression.signal,
    });
    onHold({ x: pointer.clientX, y: pointer.clientY });
  }, 500);

  document.addEventListener(
    "pointermove",
    (event) => {
      if (
        event.pointerId === pointer.pointerId &&
        Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) > 10
      ) {
        finish();
      }
    },
    options,
  );
  const release = (event: PointerEvent) => {
    if (event.pointerId === pointer.pointerId) finish();
  };
  document.addEventListener("pointerup", release, options);
  document.addEventListener("pointercancel", release, options);
  document.addEventListener("pointerdown", finish, options);
  document.addEventListener("scroll", finish, options);
  document.addEventListener("visibilitychange", finish, options);
  document.defaultView?.addEventListener("blur", finish, options);
  document.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    options,
  );

  return () => {
    finish();
    clickSuppression.abort();
  };
}
