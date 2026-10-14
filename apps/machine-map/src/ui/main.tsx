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
