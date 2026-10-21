import { createContext } from "react";
import type { VerticalHinge } from "../lib/layout";

/**
 * A creased vertical hinge in window coordinates, for overlays placed in window space. The
 * workspace publishes a new value each time its panes come to rest, since moving panes carry
 * overlay anchors with them.
 */
export const WindowHingeContext = createContext<{ readonly hinge: VerticalHinge | null }>({
  hinge: null,
});
