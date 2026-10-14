import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { Tooltip } from "./Tooltip.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");
createRoot(root).render(
  <StrictMode>
    <App />
    <Tooltip />
  </StrictMode>,
);

// MM-1801: the installed app. The worker caches only the files of the build (MM-1802).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .catch((error: unknown) => console.error("The service worker did not register", error));
}
