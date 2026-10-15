// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { SideChatControls } from "./SideChatControls";
import { SideChatContext } from "./SideChatPanel";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker } from "./TraitsPicker";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const models: ServerProviderModel[] = ["first-model", "second-model"].map((slug) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      },
    ],
  },
}));
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-15T00:00:00Z",
    models,
    slashCommands: [],
    skills: [],
  },
]);
let root: Root;
let container: HTMLDivElement;
function Fixture({ active = true }: { active?: boolean }) {
  const [draft, setDraft] = useState("unsent side question");
  const [model, setModel] = useState(models[0]!.slug);
  const [options, setOptions] = useState([{ id: "reasoningEffort", value: "high" }]);
  return (
    <>
      <textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <SideChatContext visible={active} />
      <SideChatControls active={active}>
        <ProviderModelPicker
          environmentId={null}
          lockedProvider={null}
          activeInstanceId={instanceId}
          model={model}
          instanceEntries={entries}
          modelOptionsByInstance={new Map([[instanceId, models]])}
          triggerAriaLabel="Side chat model"
          onInstanceModelChange={(_, next) => setModel(next)}
        />
        <TraitsPicker
          provider={driver}
          instanceId={instanceId}
          model={model}
          models={models}
          modelOptions={options}
          prompt={draft}
          onPromptChange={setDraft}
          planModeEnabled={false}
          onModelOptionsChange={(next) =>
            setOptions((next ?? []).map((o) => ({ id: o.id, value: String(o.value) })))
          }
        />
      </SideChatControls>
    </>
  );
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}
async function click(label: string) {
  await act(() => button(label).click());
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Fixture />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("shows the model and reasoning in the footer and changes reasoning without losing the draft", async () => {
  expect(document.body.textContent).toContain("High");
  expect(document.body.textContent).toContain("first-model");
  await click("High");
  const low = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((e) =>
    e.textContent?.includes("Low"),
  );
  expect(low).toBeDefined();
  await act(() => low!.click());
  expect(button("Low")).toBeDefined();
  expect(container.querySelector("textarea")?.value).toBe("unsent side question");
});
it("closes portaled controls when its tab hides and does not reopen them on return", async () => {
  expect(document.body.textContent).toContain("first-model");
  await click("High");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(() => root.render(<Fixture active={false} />));
  await act(() => vi.runAllTimersAsync());
  expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(() => root.render(<Fixture />));
  expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe("unsent side question");
});

it("hides frozen-context help with its panel without reopening it on return", async () => {
  await click("Side chat context");
  expect(document.body.textContent).toContain("Each side chat uses the main conversation");
  await act(() => root.render(<Fixture active={false} />));
  await act(() => vi.runAllTimersAsync());
  expect(document.body.textContent).not.toContain("Each side chat uses the main conversation");
  await act(() => root.render(<Fixture />));
  expect(document.body.textContent).not.toContain("Each side chat uses the main conversation");
});
