import { createContext } from "react";
import type { VerticalHinge } from "../lib/layout";

/**
 * A creased vertical hinge in window coordinates, for overlays placed in window space. The
 * workspace publishes a new value each time a list pane resize settles, since a hinge resize
 * carries overlay anchors with the pane.
 */
export const WindowHingeContext = createContext<{ readonly hinge: VerticalHinge | null }>({
  hinge: null,
});
