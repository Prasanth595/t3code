/**
 * Fork: focus levels. The composer, timeline, right panel and sidebar are areas of the screen
 * that keyboard focus moves between. The DOM is the only state: the level is the area that
 * holds `document.activeElement`, found through markers that the areas already render.
 */
import { getClientSettings } from "../../hooks/useSettings";

export type FocusLevel = "composer" | "timeline" | "rightPanel" | "sidebar";

/** Inner levels first: the composer sits inside the chat column, beside the timeline. */
const FOCUS_LEVEL_SELECTORS = [
  ["composer", '[data-chat-composer-surface="true"]'],
  ["timeline", '[data-assistant-citation-viewport="true"]'],
  ["rightPanel", ":has(> [data-right-panel-tabbar])"],
  ["sidebar", "[data-app-sidebar]"],
] as const satisfies ReadonlyArray<readonly [FocusLevel, string]>;

const TIMELINE_SCROLLER_SELECTOR = "[data-timeline-scroller]";
const COMPOSER_EDITOR_SELECTOR = '[data-testid="composer-editor"]';
export const SIDEBAR_ROW_SELECTOR = [
  '[data-testid="sidebar-row-slim"]',
  '[data-testid="sidebar-row-card"]',
  '[data-testid="sidebar-draft-row"]',
].join(",");

function levelSelector(level: FocusLevel): string {
  const entry = FOCUS_LEVEL_SELECTORS.find(([candidate]) => candidate === level);
  if (!entry) throw new Error(`Unknown focus level ${level}`);
  return entry[1];
}

export function focusLevelOf(target: EventTarget | null): FocusLevel | null {
  if (!(target instanceof Element)) return null;
  for (const [level, selector] of FOCUS_LEVEL_SELECTORS) {
    if (target.closest(selector)) return level;
  }
  return null;
}

export function focusLevelElement(level: FocusLevel): HTMLElement | null {
  return document.querySelector<HTMLElement>(levelSelector(level));
}

/** The `when` flags of the focus levels, for every keybinding context. */
export function focusLevelContext(target?: EventTarget | null) {
  // Keybinding helpers also run in node tests, where there is no document.
  const level =
    typeof document === "undefined" ? null : focusLevelOf(target ?? document.activeElement);
  return {
    composerFocus: level === "composer",
    timelineFocus: level === "timeline",
    rightPanelFocus: level === "rightPanel",
    sidebarFocus: level === "sidebar",
  };
}

export function timelineScroller(): HTMLElement | null {
  return (
    focusLevelElement("timeline")?.querySelector<HTMLElement>(TIMELINE_SCROLLER_SELECTOR) ?? null
  );
}

function focusTarget(level: FocusLevel): HTMLElement | null {
  const root = focusLevelElement(level);
  if (!root) return null;
  switch (level) {
    case "composer":
      return root.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR);
    case "timeline":
      return root.querySelector<HTMLElement>(TIMELINE_SCROLLER_SELECTOR);
    case "rightPanel":
      return (
        root.querySelector<HTMLElement>(
          '[data-active-tab="true"] [data-right-panel-tab-activate]',
        ) ?? root.querySelector<HTMLElement>("[data-right-panel-tab-activate]")
      );
    case "sidebar":
      return (
        root.querySelector<HTMLElement>(`:is(${SIDEBAR_ROW_SELECTOR})[aria-current="page"]`) ??
        root.querySelector<HTMLElement>(`:is(${SIDEBAR_ROW_SELECTOR})[aria-current="true"]`) ??
        root.querySelector<HTMLElement>(SIDEBAR_ROW_SELECTOR)
      );
  }
}

/** Moves focus into a level. False when the level is not on screen. */
export function focusLevel(level: FocusLevel): boolean {
  const target = focusTarget(level);
  if (!target) return false;
  target.focus({ preventScroll: level !== "sidebar" });
  if (level === "sidebar") target.scrollIntoView({ block: "nearest" });
  return document.activeElement === target || target.contains(document.activeElement);
}

const UP: Record<FocusLevel, FocusLevel | null> = {
  composer: "timeline",
  timeline: "sidebar",
  rightPanel: "sidebar",
  sidebar: null,
};

export function focusLevelUp(from: FocusLevel): boolean {
  const next = UP[from];
  return next !== null && focusLevel(next);
}

/** Left to right on screen: sidebar, then the chat column, then the right panel. */
export function focusLevelSideways(from: FocusLevel, direction: "left" | "right"): boolean {
  if (direction === "left") {
    if (from === "rightPanel") return focusLevel("timeline");
    if (from === "composer" || from === "timeline") return focusLevel("sidebar");
    return false;
  }
  if (from === "sidebar") return focusLevel("timeline");
  if (from === "composer" || from === "timeline") return focusLevel("rightPanel");
  return false;
}

/**
 * The highlight: one outline fade on the area that takes focus. It runs once per change, so it
 * does not repaint while the user works.
 */
export function watchFocusLevelChanges(): () => void {
  let previous = focusLevelOf(document.activeElement);
  const onFocusIn = (event: FocusEvent) => {
    const level = focusLevelOf(event.target);
    if (level === null || level === previous) {
      previous = level ?? previous;
      return;
    }
    previous = level;
    if (!getClientSettings().focusLevelHighlight) return;
    const element = focusLevelElement(level);
    if (!element) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.animate(
      [
        { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
        { outline: "2px solid transparent", outlineOffset: "-2px" },
      ],
      { duration: 450, easing: reduceMotion ? "step-end" : "ease-out" },
    );
  };
  document.addEventListener("focusin", onFocusIn);
  return () => document.removeEventListener("focusin", onFocusIn);
}
