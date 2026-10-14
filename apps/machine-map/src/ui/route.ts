/** MM-1106: each view and each selected item has its own hash link. */

export const VIEWS = [
  "map",
  "table",
  "health",
  "settings",
  "queue",
  "tasks",
  "history",
  "inbox",
  "clients",
] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<View, string> = {
  map: "Map",
  table: "Table",
  health: "Health",
  settings: "Settings",
  queue: "Queue",
  tasks: "Tasks",
  history: "History",
  inbox: "Inbox",
  clients: "Clients",
};

export type Selection =
  | { readonly _tag: "none" }
  | { readonly _tag: "machine"; readonly id: string }
  | { readonly _tag: "arrow"; readonly from: string; readonly to: string }
  | { readonly _tag: "revision"; readonly revision: number }
  | { readonly _tag: "proposal"; readonly id: string }
  | { readonly _tag: "setting"; readonly scope: "server" | "client"; readonly key: string }
  | { readonly _tag: "command"; readonly id: string };

export interface Route {
  readonly view: View;
  readonly selection: Selection;
}

export const NO_SELECTION: Selection = { _tag: "none" };
export const DEFAULT_ROUTE: Route = { view: "map", selection: NO_SELECTION };

const isView = (value: string | undefined): value is View => VIEWS.some((view) => view === value);

export function formatRoute(route: Route): string {
  const s = route.selection;
  const tail = ((): Array<string | number> => {
    switch (s._tag) {
      case "none":
        return [];
      case "machine":
        return ["machine", s.id];
      case "arrow":
        return ["arrow", s.from, s.to];
      case "revision":
        return ["revision", s.revision];
      case "proposal":
        return ["proposal", s.id];
      case "setting":
        return ["setting", s.scope, s.key];
      case "command":
        return ["command", s.id];
    }
  })();
  return `#/${[route.view, ...tail].map((part) => encodeURIComponent(String(part))).join("/")}`;
}

/** Unknown or broken hashes open the default route, so an old link never breaks the page. */
export function parseRoute(hash: string): Route {
  const parts = hash
    .slice(hash.startsWith("#") ? 1 : 0)
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
  const [view, kind, a, b] = parts;
  if (!isView(view)) return DEFAULT_ROUTE;
  const selection = ((): Selection => {
    if (kind === "machine" && a) return { _tag: "machine", id: a };
    if (kind === "arrow" && a && b) return { _tag: "arrow", from: a, to: b };
    if (kind === "revision" && a && Number.isSafeInteger(Number(a))) {
      return { _tag: "revision", revision: Number(a) };
    }
    if (kind === "proposal" && a) return { _tag: "proposal", id: a };
    if (kind === "setting" && (a === "server" || a === "client") && b)
      return { _tag: "setting", scope: a, key: b };
    if (kind === "command" && a) return { _tag: "command", id: a };
    return NO_SELECTION;
  })();
  return { view, selection };
}
