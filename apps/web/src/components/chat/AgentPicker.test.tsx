import { AgentId, type AgentSummary } from "@t3tools/contracts";
import { act, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/menu", async () => {
  const React = await import("react");
  const MenuContext = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  } | null>(null);
  const RadioContext = React.createContext<{
    value: string;
    onValueChange: (value: string) => void;
  } | null>(null);
  return {
    Menu: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => <MenuContext.Provider value={{ open, onOpenChange }}>{children}</MenuContext.Provider>,
    MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) => {
      const menu = React.useContext(MenuContext)!;
      return React.cloneElement(
        render as React.ReactElement<Record<string, unknown>>,
        { onClick: () => menu.onOpenChange(!menu.open) },
        children,
      );
    },
    MenuPopup: ({ children }: { children: ReactNode }) => {
      const menu = React.useContext(MenuContext)!;
      return menu.open ? <div role="menu">{children}</div> : null;
    },
    MenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    MenuRadioGroup: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => (
      <RadioContext.Provider value={{ value, onValueChange }}>{children}</RadioContext.Provider>
    ),
    MenuRadioItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const menu = React.useContext(MenuContext)!;
      const radio = React.useContext(RadioContext)!;
      return (
        <button
          aria-checked={radio.value === value}
          data-value={value}
          role="menuitemradio"
          onClick={() => {
            radio.onValueChange(value);
            menu.onOpenChange(false);
          }}
        >
          {children}
        </button>
      );
    },
    MenuSeparator: () => <hr />,
  };
});

vi.mock("./ComposerControl", () => ({
  ComposerControl: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  ComposerControlChevron: () => null,
  ComposerControlIcon: () => null,
}));

vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { AgentPicker } from "./AgentPicker";

const sampleAgents: ReadonlyArray<AgentSummary> = [
  {
    id: AgentId.make("code-reviewer"),
    name: "Code Reviewer",
    description: "Reviews pull requests and provides detailed feedback",
    tier: "reasoning",
  },
  {
    id: AgentId.make("doc-writer"),
    name: "Documentation Writer",
    description: "Generates clear and concise documentation",
    tier: "economy",
  },
];

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("distinguishes inheriting the project default from explicitly choosing no agent", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  function PickerHarness() {
    const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null | undefined>(undefined);
    return (
      <AgentPicker
        agents={sampleAgents}
        defaultAgentId={AgentId.make("code-reviewer")}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
        allowNone
      />
    );
  }

  act(() => {
    renderer = create(<PickerHarness />);
  });
  const label = () =>
    renderer.root.findByProps({ "data-composer-control-label": true }).children.join("");
  const choose = (value: string) => {
    const item = renderer.root.findByProps({ "data-value": value });
    act(() => item.props.onClick());
  };

  expect(label()).toBe("Code Reviewer (Default)");
  act(() => renderer.root.findByProps({ "aria-label": "Select custom agent" }).props.onClick());
  choose("none");
  expect(label()).toBe("No custom agent");
  act(() => renderer.root.findByProps({ "aria-label": "Select custom agent" }).props.onClick());
  expect(renderer.root.findByProps({ "data-value": "none" }).props["aria-checked"]).toBe(true);

  choose("default");
  expect(label()).toBe("Code Reviewer (Default)");
  act(() => renderer.root.findByProps({ "aria-label": "Select custom agent" }).props.onClick());
  expect(renderer.root.findByProps({ "data-value": "default" }).props["aria-checked"]).toBe(true);
});
