import { act, Suspense, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPanelRegistry } from "./panelRegistry";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// Exercise lazy loading, retained local state, and mount/disposal in the client.
describe("panel registry", () => {
  it("rejects duplicate ids without loading either panel", () => {
    const load = vi.fn();
    const definition = { id: "diff", load } as const;
    expect(() => createPanelRegistry([definition, definition])).toThrow("Duplicate panel id: diff");
    expect(load).not.toHaveBeenCalled();
  });

  it("does no work until opened and keeps one mount across lookups", async () => {
    let finish!: (value: { default: typeof Panel }) => void;
    const loaded = new Promise<{ default: typeof Panel }>((resolve) => {
      finish = resolve;
    });
    const mounted = vi.fn();
    const disposed = vi.fn();
    function Panel() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounted();
        return disposed;
      }, []);
      return <button onClick={() => setCount((current) => current + 1)}>Count {count}</button>;
    }
    const load = vi.fn(() => loaded);
    const registry = createPanelRegistry([{ id: "diff", load }]);
    expect(load).not.toHaveBeenCalled();
    const Component = registry.get("diff")!.Component;
    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <Component />
        </Suspense>,
      );
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).not.toHaveBeenCalled();
    await act(async () => {
      finish({ default: Panel });
      await loaded;
    });
    expect(mounted).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toBe("Count 1");
    // A parent re-render looks the panel up again; it must keep the same mount and state.
    const Again = registry.get("diff")!.Component;
    expect(Again).toBe(Component);
    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <Again />
        </Suspense>,
      );
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Count 1");
    await act(async () => root.render(null));
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
