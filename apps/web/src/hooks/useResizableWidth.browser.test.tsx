import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useResizableWidth } from "./useResizableWidth";

const STORAGE_KEY = "t3code:test:resizable-width";

function Probe() {
  const { width } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth: 400,
    minWidth: 300,
    maxWidth: 800,
    edge: "left",
  });
  return <output>{width}</output>;
}

describe("useResizableWidth", () => {
  it("follows a width another tab stores under the same key", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.removeItem(STORAGE_KEY) };
    await using screen = await render(<Probe />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
    await expect.element(screen.getByText("400")).toBeInTheDocument();

    // Another tab's write reaches this one only as a storage event.
    await act(() => {
      localStorage.setItem(STORAGE_KEY, "640");
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });
    await expect.element(screen.getByText("640")).toBeInTheDocument();
  });
});
