import type { NavigationState, PartialState } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  applied: [] as { draftKey: string; text: string }[],
  root: undefined as NavigationState | undefined,
}));

vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("./prompt-link-actions", () => ({
  applyLinkedPromptToThreadDraft: async (draftKey: string, prompt: { text: string }) => {
    fixture.applied.push({ draftKey, text: prompt.text });
  },
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { getRootState: () => fixture.root },
}));
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const shell = Atom.make<object | null>(null);
  return { environmentThreadShells: { threadShellAtom: () => shell }, fixtureShell: shell };
});

const { appAtomRegistry } = await import("../../state/atom-registry");
const { fixtureShell } = (await import("../../state/threads")) as unknown as {
  fixtureShell: Atom.Writable<object | null>;
};
const { resolvePendingThreadPromptLink, takeThreadPromptLink } = await import("./threadPromptLink");

function setup() {
  fixture.applied.length = 0;
  fixture.root = undefined;
  appAtomRegistry.set(fixtureShell, null);
}

const threadParams = { environmentId: "env-1", threadId: "thread-1" };

function linkedState(): PartialState<NavigationState> {
  return { routes: [{ name: "Thread", params: { ...threadParams, prompt: "Fix the bug" } }] };
}

function stack(routes: NavigationState["routes"]): NavigationState {
  return {
    key: "root",
    index: routes.length - 1,
    routeNames: routes.map((route) => route.name),
    routes,
    stale: false,
    type: "stack",
  };
}

const threadRoute = stack([{ key: "thread", name: "Thread", params: threadParams }]);

describe("takeThreadPromptLink", () => {
  it("writes no draft for a thread that never shows", () => {
    setup();
    takeThreadPromptLink(linkedState());
    expect(fixture.applied).toEqual([]);

    resolvePendingThreadPromptLink(threadRoute);
    // An unknown thread's screen replaces itself with a new-thread draft.
    resolvePendingThreadPromptLink(
      stack([{ key: "draft", name: "Thread", params: { draft: { draftId: "d" } } }]),
    );
    appAtomRegistry.set(fixtureShell, { id: "thread-1" });
    expect(fixture.applied).toEqual([]);
  });

  it("fills the draft once the linked thread shows on its screen", () => {
    setup();
    takeThreadPromptLink(linkedState());
    fixture.root = threadRoute;
    resolvePendingThreadPromptLink(threadRoute);
    expect(fixture.applied).toEqual([]);

    appAtomRegistry.set(fixtureShell, { id: "thread-1" });
    expect(fixture.applied).toEqual([{ draftKey: expect.any(String), text: "Fix the bug" }]);
    appAtomRegistry.set(fixtureShell, { id: "thread-1", title: "renamed" });
    expect(fixture.applied).toHaveLength(1);
  });
});
