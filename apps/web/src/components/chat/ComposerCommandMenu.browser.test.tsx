import { EnvironmentId, ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.width = "360px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function commandItem(id: string, description: string): ComposerCommandItem {
  return {
    id,
    type: "slash-command",
    command: "model",
    label: `/${id}`,
    description,
  };
}

function skillItem(
  id: string,
  description: string,
  skill: Partial<ServerProviderSkill> = {},
): ComposerCommandItem {
  return {
    id,
    type: "skill",
    provider: ProviderDriverKind.make("claudeAgent"),
    skill: { name: id, path: `/skills/${id}/SKILL.md`, enabled: true, description, ...skill },
    label: `/skill:${id}`,
    description,
  };
}

async function renderDetail(item: ComposerCommandItem) {
  await act(async () =>
    root.render(
      <ComposerCommandMenu
        listId="suggestions"
        environmentId={EnvironmentId.make("environment-1")}
        items={[item]}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="skill"
        activeItemId={item.id}
        detailItem={item}
        onHighlightedItemChange={() => {}}
        onShowDetail={() => {}}
        onCloseDetail={() => {}}
        onSelect={() => {}}
      />,
    ),
  );
}

async function renderActive(item: ComposerCommandItem) {
  await act(async () =>
    root.render(
      <ComposerCommandMenu
        listId="suggestions"
        environmentId={EnvironmentId.make("environment-1")}
        items={[item]}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={item.id}
        detailItem={null}
        onHighlightedItemChange={() => {}}
        onShowDetail={() => {}}
        onCloseDetail={() => {}}
        onSelect={() => {}}
      />,
    ),
  );
  return container.querySelector(`[aria-label^="Show details for ${item.label}"]`);
}

describe("ComposerCommandMenu detail button", () => {
  it("appears on a command only when its description is cut off", async () => {
    expect(await renderActive(commandItem("short", "Fits"))).toBeNull();
    expect(
      await renderActive(commandItem("long", "A description that keeps going ".repeat(10))),
    ).not.toBeNull();
  });

  it("appears on the active command once a narrower menu cuts its description off", async () => {
    const item = commandItem("narrowed", "A description that fits on one line only in a wide menu");
    container.style.width = "1600px";
    expect(await renderActive(item)).toBeNull();

    await act(async () => {
      container.style.width = "260px";
      for (let frame = 0; frame < 2; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    expect(container.querySelector('[aria-label^="Show details for /narrowed"]')).not.toBeNull();
  });

  it("appears on every skill, even when its description fits", async () => {
    expect(await renderActive(skillItem("tidy", "Fits"))).not.toBeNull();
  });
});

describe("ComposerCommandMenu detail panel", () => {
  it("shows a skill's full description rather than its short one", async () => {
    await renderDetail(
      skillItem("release", "Short summary", {
        shortDescription: "Short summary",
        description: "The full description with every detail",
      }),
    );
    expect(container.textContent).toContain("The full description with every detail");
    expect(container.textContent).not.toContain("Short summary");
  });
});
