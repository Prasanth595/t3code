import { showBootError } from "./lib/bootError";

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
if (!document.documentElement.dataset.desktopStartup) {
  void import("./main").then(({ startup }) => startup).catch(showBootError);
}
