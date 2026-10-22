import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { fakeTimers } from "../../test/render";
import { createSidebarShiftGuard } from "./Sidebar.shiftGuard";

function mountList(names: readonly string[]) {
  const list = document.createElement("ul");
  list.style.cssText = "position: relative; margin: 0; padding: 0; width: 200px; list-style: none";
  const pressed: string[] = [];
  const rows = new Map<string, HTMLLIElement>();
  for (const name of names) {
    const row = document.createElement("li");
    row.style.height = "40px";
    const button = document.createElement("button");
    button.textContent = name;
    button.addEventListener("click", () => pressed.push(name));
    row.append(button);
    list.append(row);
    rows.set(name, row);
  }
  document.body.append(list);
  const guard = createSidebarShiftGuard(list);
  return {
    pressed,
    guard,
    button: (name: string) => rows.get(name)!.querySelector("button")!,
    remove: (name: string) => rows.get(name)!.remove(),
    [Symbol.dispose]() {
      guard.dispose();
      list.remove();
    },
  };
}

describe("sidebar shift guard", () => {
  it("drops a press on a row that slid up on its own, then accepts it after the delay", async () => {
    using _clock = fakeTimers();
    vi.advanceTimersByTime(1_000);
    using list = mountList(["A", "B", "C"]);

    list.remove("A");
    list.guard.update();
    await userEvent.click(list.button("B"));
    expect(list.pressed).toEqual([]);

    vi.advanceTimersByTime(500);
    await userEvent.click(list.button("B"));
    expect(list.pressed).toEqual(["B"]);
  });

  it("keeps rows that did not move clickable", async () => {
    using _clock = fakeTimers();
    vi.advanceTimersByTime(1_000);
    using list = mountList(["A", "B", "C"]);

    list.remove("C");
    list.guard.update();
    await userEvent.click(list.button("A"));
    expect(list.pressed).toEqual(["A"]);
  });

  it("lets the user act on the row their own press moved", async () => {
    using _clock = fakeTimers();
    vi.advanceTimersByTime(1_000);
    using list = mountList(["A", "B", "C"]);
    list.button("A").addEventListener("click", () => {
      list.remove("A");
      list.guard.update();
    });

    await userEvent.click(list.button("A"));
    await userEvent.click(list.button("B"));
    expect(list.pressed).toEqual(["A", "B"]);
  });

  it("clears an earlier mark when the user's own input moves the row again", async () => {
    using _clock = fakeTimers();
    vi.advanceTimersByTime(1_000);
    using list = mountList(["A", "B", "C", "D"]);

    list.remove("A");
    list.guard.update();
    await userEvent.keyboard("{Escape}");
    list.remove("B");
    list.guard.update();
    await userEvent.click(list.button("C"));
    expect(list.pressed).toEqual(["C"]);
  });
});
