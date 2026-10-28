export const TIMELINE_ITEM_SELECTOR = "[data-timeline-item]";
const TAB_STOP = `${TIMELINE_ITEM_SELECTOR}[tabindex="0"]`;
const OWNER = `${TIMELINE_ITEM_SELECTOR}, [data-timeline-controls-for]`;
const CONTROL =
  'button, a[href], input, textarea, select, summary, iframe, audio[controls], video[controls], [contenteditable="true"], [tabindex]';
const TEXT_ENTRY = 'input, textarea, select, [contenteditable="true"]';

export const TIMELINE_LIST_PROPS = { role: "list", "aria-label": "Messages" } as const;

export const timelineItemSelector = (id: string) => `[data-timeline-item="${CSS.escape(id)}"]`;

/**
 * How far to scroll so the item's top is in view, and all of it when it fits.
 * `bottomInset` is the part of the viewport the composer covers.
 */
export function timelineRevealDelta(viewport: DOMRect, item: DOMRect, bottomInset: number) {
  const bottom = viewport.bottom - bottomInset;
  if (item.top < viewport.top) return item.top - viewport.top;
  if (item.bottom > bottom) return Math.min(item.bottom - bottom, item.top - viewport.top);
  return 0;
}

// Module scope so a reinstall (StrictMode, a remounted list) still reads each control's own value.
const ownTabIndex = new WeakMap<HTMLElement, number>();
const appliedTabIndex = new WeakMap<HTMLElement, number>();

function setReachable(control: HTMLElement, reachable: boolean) {
  if (control.matches(TIMELINE_ITEM_SELECTOR) || control.matches(TEXT_ENTRY)) return;
  // A tab index that differs from the one applied here was set by its renderer.
  if (!ownTabIndex.has(control) || control.tabIndex !== appliedTabIndex.get(control))
    ownTabIndex.set(control, control.tabIndex);
  const tabIndex = reachable ? ownTabIndex.get(control)! : -1;
  if (control.tabIndex !== tabIndex) control.tabIndex = tabIndex;
  appliedTabIndex.set(control, tabIndex);
}

function controlsIn(node: Element) {
  const controls = Array.from(node.querySelectorAll<HTMLElement>(CONTROL));
  return node instanceof HTMLElement && node.matches(CONTROL) ? [node, ...controls] : controls;
}

/**
 * Tab reaches the controls of the list's Tab-stop item only (the item rendered with
 * tabindex 0, plus anything linked to it with `data-timeline-controls-for`), so the
 * list stays one stop for the rest. Only added subtrees are visited as the list streams.
 * When the focused item leaves the list, focus moves to the new Tab stop.
 */
export function installTimelineControls(root: HTMLElement) {
  let stopId: string | undefined;
  // Removing a focused element drops focus to the body without a focusout event.
  let ownsFocus = root.contains(document.activeElement);
  const onFocusIn = (event: FocusEvent) => {
    ownsFocus = root.contains(event.target as Node);
  };
  // A click on text elsewhere drops focus to the body too, and must not pull it back.
  const onPointerDown = (event: PointerEvent) => {
    const active = document.activeElement;
    if (active === document.body || !active?.contains(event.target as Node)) ownsFocus = false;
  };
  const controlsOf = (id: string) =>
    Array.from(
      root.querySelectorAll(
        `${timelineItemSelector(id)}, [data-timeline-controls-for="${CSS.escape(id)}"]`,
      ),
    ).flatMap(controlsIn);
  const setStop = (id: string | undefined) => {
    if (id === stopId) return;
    const previous = stopId;
    stopId = id;
    if (previous !== undefined)
      for (const control of controlsOf(previous)) setReachable(control, false);
    if (id !== undefined) for (const control of controlsOf(id)) setReachable(control, true);
  };
  const sync = (node: Element) => {
    for (const control of controlsIn(node)) {
      const owner = control.closest<HTMLElement>(OWNER);
      const id = owner?.dataset.timelineItem ?? owner?.dataset.timelineControlsFor;
      if (id !== undefined) setReachable(control, id === stopId);
    }
  };

  setStop(root.querySelector<HTMLElement>(TAB_STOP)?.dataset.timelineItem);
  sync(root);
  const observer = new MutationObserver((records) => {
    let stop: HTMLElement | null = null;
    const added: Element[] = [];
    for (const record of records) {
      if (record.type === "attributes") {
        if (!(record.target instanceof HTMLElement)) continue;
        if (record.target.matches(TAB_STOP)) stop = record.target;
        else if (!record.target.matches(TIMELINE_ITEM_SELECTOR)) added.push(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        added.push(node);
        const found = node.matches(TAB_STOP) ? node : node.querySelector(TAB_STOP);
        if (found instanceof HTMLElement) stop = found;
      }
    }
    if (stop?.isConnected) setStop(stop.dataset.timelineItem);
    for (const node of added) if (node.isConnected) sync(node);
    if (ownsFocus && document.activeElement === document.body)
      root.querySelector<HTMLElement>(TAB_STOP)?.focus({ preventScroll: true });
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["tabindex"],
  });
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}
