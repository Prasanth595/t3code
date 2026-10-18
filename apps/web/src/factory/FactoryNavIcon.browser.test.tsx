import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "./testing";

const state = vi.hoisted(() => ({ count: 0 }));
vi.mock("./useFactoryData", () => ({ useFactoryAttentionCount: () => state.count }));

import { FactoryNavIcon } from "./FactoryNavIcon";

describe("FactoryNavIcon", () => {
  it("shows no badge at zero", async () => {
    state.count = 0;
    const icon = await render(createElement(FactoryNavIcon));
    expect(icon.text()).toBe("");
  });

  it("shows the number of open attention items", async () => {
    state.count = 3;
    const icon = await render(createElement(FactoryNavIcon));
    expect(icon.text()).toBe("3");
  });
});
