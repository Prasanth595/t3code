// Evaluates a built runtime.js in Node with a minimal DOM stand-in and checks window.NoFunUI.
//   node src/runtime-bundle/smoke.ts <dist/nofun-ui-runtime/<sha>>
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeVm from "node:vm";

const dir = NodePath.resolve(process.argv[2] ?? ".");
const manifest = JSON.parse(NodeFs.readFileSync(NodePath.join(dir, "manifest.json"), "utf8")) as {
  sha: string;
  componentCount: number;
};

// Anything a module touches at load time answers with another permissive stub.
const stub = (): unknown =>
  new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : stub()),
    apply: () => stub(),
    construct: () => stub() as object,
  });
const element = () =>
  new Proxy(
    {
      style: {},
      dataset: {},
      getAttribute: () => null,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    } as Record<PropertyKey, unknown>,
    { get: (target, key) => (key in target ? target[key] : stub()) },
  );
const document = {
  currentScript: { src: `nofun-ui://runtime/${manifest.sha}/runtime.js` },
  createElement: element,
  createElementNS: element,
  createTextNode: element,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  documentElement: element(),
  head: element(),
  body: element(),
};
const window: Record<string, unknown> = {
  document,
  navigator: { userAgent: "node", platform: "node" },
  location: { href: "nofun-card://smoke/index.html", protocol: "nofun-card:" },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  HTMLElement: class {},
  Element: class {},
  Node: class {},
  CSS: { supports: () => false },
  ResizeObserver: stub(),
  IntersectionObserver: stub(),
  MutationObserver: stub(),
};
window.window = window;
window.self = window;
window.globalThis = window;
const context = NodeVm.createContext(
  new Proxy(window, {
    get: (target, key) =>
      key in target ? target[key as string] : key in globalThis ? (globalThis as never)[key] : undefined,
    has: () => true,
  }),
);

const started = performance.now();
NodeVm.runInContext(NodeFs.readFileSync(NodePath.join(dir, "runtime.js"), "utf8"), context, {
  filename: "runtime.js",
});
const ui = window.NoFunUI as
  | { version: string; components: Record<string, unknown>; modules: Record<string, unknown> }
  | undefined;
if (!ui) throw new Error("runtime.js did not define window.NoFunUI");
const names = Object.keys(ui.components);
const missing = names.filter((name) => ui.components[name] === undefined);
console.log(
  `NoFunUI ${ui.version}: ${names.length} components (${manifest.componentCount} in manifest), ${Object.keys(ui.modules).length} modules, evaluated in ${Math.round(performance.now() - started)} ms`,
);
for (const name of ["kpi-group", "chart-bar", "timeline", "kobra/button"]) {
  console.log(`  ${name}: ${typeof ui.components[name]}`);
}
if (names.length < 400 || missing.length > 0) {
  console.error(`expected >= 400 resolved components; missing: ${missing.join(", ")}`);
  process.exitCode = 1;
}
