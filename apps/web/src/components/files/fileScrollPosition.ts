interface FileScrollPosition {
  top: number;
  handledRevealRequestId: number | null;
}

const MAX_POSITIONS = 200;
const positions = new Map<string, FileScrollPosition>();

export function getFileScrollPosition(key: string): FileScrollPosition {
  let position = positions.get(key);
  if (!position) position = { top: 0, handledRevealRequestId: null };
  positions.delete(key);
  positions.set(key, position);
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value!);
  return position;
}

// Editor attachment and late layout measurements can reset a restored scroll.
export function guardFileScrollTarget(container: HTMLElement, resolveTarget: () => number | null) {
  let framesLeft = 20;
  let frameId: number | null = null;
  const cancel = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    container.removeEventListener("wheel", cancel);
    container.removeEventListener("touchstart", cancel);
    container.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("keydown", cancel, true);
  };
  const restore = () => {
    frameId = null;
    if (--framesLeft <= 0 || !container.isConnected) {
      cancel();
      return;
    }
    const top = resolveTarget();
    if (top !== null && Math.abs(container.scrollTop - top) > 2) container.scrollTop = top;
    frameId = requestAnimationFrame(restore);
  };
  container.addEventListener("wheel", cancel, { passive: true });
  container.addEventListener("touchstart", cancel, { passive: true });
  // Gutter interactions stop bubbling, so cancel before the editor handles them.
  container.addEventListener("pointerdown", cancel, { passive: true, capture: true });
  window.addEventListener("keydown", cancel, true);
  frameId = requestAnimationFrame(restore);
  return cancel;
}
