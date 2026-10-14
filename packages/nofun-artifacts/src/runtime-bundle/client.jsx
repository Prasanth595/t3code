// Browser side of the shared runtime (dist/nofun-ui-runtime/<sha>/runtime.js). build.ts bundles every
// registry module and calls install() once; linked artifacts then import through NoFunUI.require and
// render through NoFunUI.mount. Plain JSX so tsc skips it: it imports the live checkout's aliases.
import { createRoot } from "react-dom/client";

import { ArtifactBoundary } from "../runtime/mount.tsx";
import { SpecNode } from "../runtime/render-spec.tsx";

const isComponent = (value) =>
  typeof value === "function" ||
  (typeof value === "object" && value !== null && typeof value.$$typeof === "symbol");

export function install({ version, modules, components, brands }) {
  const script = document.currentScript;
  const base = script && script.src ? script.src.slice(0, script.src.lastIndexOf("/") + 1) : "./";
  const required = new Map();
  const resolved = {};
  for (const [name, [specifier, exportName]] of Object.entries(components)) {
    const value = modules[specifier]?.[exportName];
    if (value !== undefined) resolved[name] = value;
  }
  let schemeQuery;
  let schemeListener;

  /** A module for a linked artifact, as `import` sees it (esModule-flagged so `default` maps through). */
  function require(specifier) {
    let mod = required.get(specifier);
    if (mod) return mod;
    const ns = modules[specifier];
    if (!ns) {
      throw new Error(`"${specifier}" is not in No Fun UI runtime ${version}.`);
    }
    mod = { __esModule: true, ...ns };
    required.set(specifier, mod);
    return mod;
  }

  /** Renders a component, a module with a default export, or a catalog spec (`{ root }` or a node). */
  function mount(el, input) {
    const root = createRoot(el);
    const App = isComponent(input)
      ? input
      : isComponent(input?.default)
        ? input.default
        : undefined;
    const node = App ? <App /> : <SpecNode node={input?.root ?? input} />;
    root.render(<ArtifactBoundary>{node}</ArtifactBoundary>);
    return { unmount: () => root.unmount() };
  }

  /**
   * Scopes `el` (default <body>) to a brand and loads its sheet beside runtime.js. Two-scheme brands
   * follow `scheme` or the system appearance; `t3`/null clears the brand.
   */
  function theme(id, { el = document.body, scheme } = {}) {
    if (schemeQuery && schemeListener) schemeQuery.removeEventListener("change", schemeListener);
    schemeQuery = schemeListener = undefined;
    el.classList.remove("dark");
    for (const attr of ["data-brand", "data-nf-theme", "data-nf-scheme", "data-theme"]) {
      el.removeAttribute(attr);
    }
    if (!id || id === "t3") return;
    const brand = brands[id];
    if (!brand) throw new Error(`Unknown brand "${id}" in No Fun UI runtime ${version}.`);
    if (!document.querySelector(`link[data-nf-brand="${id}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${base}brands/${id}.css`;
      link.dataset.nfBrand = id;
      document.head.appendChild(link);
    }
    el.setAttribute("data-nf-theme", id);
    el.setAttribute("data-brand", id);
    const setDark = (dark) => {
      el.classList.toggle("dark", dark);
      if (dark) el.setAttribute("data-theme", "dark");
      else el.removeAttribute("data-theme");
    };
    if (brand.schemes.length === 1) {
      el.setAttribute("data-nf-scheme", brand.schemes[0]);
      setDark(brand.schemes[0] === "dark");
    } else if (scheme) {
      setDark(scheme === "dark");
    } else if (window.matchMedia) {
      schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
      schemeListener = () => setDark(schemeQuery.matches);
      schemeQuery.addEventListener("change", schemeListener);
      schemeListener();
    }
  }

  window.NoFunUI = { version, base, components: resolved, modules, brands, require, mount, theme };
}
