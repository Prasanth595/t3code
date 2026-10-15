import { useCallback, useSyncExternalStore } from "react";

const BREAKPOINTS = {
  "2xl": 1536,
  "3xl": 1600,
  "4xl": 2000,
  lg: 1024,
  md: 768,
  sm: 640,
  xl: 1280,
} as const;

type Breakpoint = keyof typeof BREAKPOINTS;

type BreakpointQuery = Breakpoint | `max-${Breakpoint}` | `${Breakpoint}:max-${Breakpoint}`;

function resolveMin(value: Breakpoint | number): string {
  const px = typeof value === "number" ? value : BREAKPOINTS[value];
  return `(min-width: ${px}px)`;
}

function resolveMax(value: Breakpoint | number): string {
  const px = typeof value === "number" ? value : BREAKPOINTS[value];
  return `(max-width: ${px - 1}px)`;
}

function parseQuery(query: BreakpointQuery | MediaQueryInput | (string & {})): string {
  if (typeof query !== "string") {
    const parts: string[] = [];
    if (query.min != null) parts.push(resolveMin(query.min));
    if (query.max != null) parts.push(resolveMax(query.max));
    if (query.pointer === "coarse") parts.push("(pointer: coarse)");
    if (query.pointer === "fine") parts.push("(pointer: fine)");
    if (parts.length === 0) return "(min-width: 0px)";
    return parts.join(" and ");
  }

  if (query.startsWith("(")) return query;

  const parts: string[] = [];
  for (const segment of query.split(":")) {
    if (segment.startsWith("max-")) {
      const bp = segment.slice(4);
      if (bp in BREAKPOINTS) parts.push(resolveMax(bp as Breakpoint));
    } else if (segment in BREAKPOINTS) {
      parts.push(resolveMin(segment as Breakpoint));
    }
  }

  return parts.length > 0 ? parts.join(" and ") : query;
}

function getServerSnapshot(): boolean {
  return false;
}

export type MediaQueryInput = {
  min?: Breakpoint | number;
  max?: Breakpoint | number;
  /** Touch-like input (finger). Use "fine" for mouse/trackpad. */
  pointer?: "coarse" | "fine";
};

export function useMediaQuery(query: BreakpointQuery | MediaQueryInput | (string & {})): boolean {
  const mediaQuery = parseQuery(query);

  const subscribe = useCallback(
    (callback: () => void) => {
      if (typeof window === "undefined") return () => {};
      const mql = window.matchMedia(mediaQuery);
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    [mediaQuery],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(mediaQuery).matches;
  }, [mediaQuery]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useIsMobile(): boolean {
  return useMediaQuery("max-md");
}

function subscribeToScreenOrientation(onChange: () => void): () => void {
  const orientation = window.screen?.orientation;
  if (orientation) {
    orientation.addEventListener("change", onChange);
    return () => orientation.removeEventListener("change", onChange);
  }
  const mql = window.matchMedia("(orientation: portrait)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** The device's orientation, not the viewport's: under interactive-widget=resizes-content an
    Android keyboard shrinks the viewport until it is wider than tall, which an
    `(orientation: portrait)` query would read as landscape mid-typing. Safari before 16.4 has no
    screen.orientation, and iOS never resizes the layout viewport, so the query is safe there. */
function readScreenIsPortrait(): boolean {
  const type = window.screen?.orientation?.type;
  if (type) return type.startsWith("portrait");
  return window.matchMedia("(orientation: portrait)").matches;
}

/** A portrait touch phone, as opposed to a narrow desktop window or a small phone on its side. */
export function useIsPhoneViewport(): boolean {
  const isPhoneSized = useMediaQuery("(max-width: 639px) and (pointer: coarse)");
  const isPortrait = useSyncExternalStore(
    subscribeToScreenOrientation,
    readScreenIsPortrait,
    getServerSnapshot,
  );
  return isPhoneSized && isPortrait;
}
