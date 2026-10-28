import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  forgetTemporaryThread,
  setTemporaryThread,
} from "@t3tools/client-runtime/temporary-threads";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

const fixtures = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  const reads: string[] = [];
  return {
    registry: AtomRegistry.make(),
    reads,
    shells: Atom.family<string, Atom.Writable<{ temporary: boolean }>>(() =>
      Atom.make<{ temporary: boolean }>({ temporary: false }),
    ),
    details: Atom.family((id: string) =>
      Atom.make(() => {
        reads.push(id);
        return { projection: { thread: { guestShare: { id } } } };
      }),
    ),
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: vi.fn((atom: Atom.Atom<unknown>) => fixtures.registry.get(atom)),
}));
vi.mock("react", () => ({
  useMemo: (factory: () => unknown) => factory(),
  useState: vi.fn(),
  useEffect: vi.fn(),
}));
vi.mock("react-native", () => ({ View: vi.fn() }));
vi.mock("../../components/ui/Button", () => ({ Button: vi.fn() }));
vi.mock("../../components/ui/AppText", () => ({ AppText: vi.fn() }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), confirm: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./guestMessageStyle", () => ({
  GUEST_PENDING_BUBBLE_CLASS_NAME: "",
  GuestMessageName: vi.fn(),
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: {
    threadAtom: (ref: ScopedThreadRef) => fixtures.details(ref.threadId),
  },
  environmentThreadShells: {
    quietThreadShellAtom: (ref: ScopedThreadRef) => fixtures.shells(ref.threadId),
  },
  threadEnvironment: {},
}));

import { useThreadGuestShare } from "./ThreadGuestShareBar";

it("does not read guest details before creation admission", () => {
  fixtures.reads.length = 0;

  expect(useThreadGuestShare(null)).toBeNull();
  expect(fixtures.reads).toEqual([]);
});

it.each(["shell", "registry"] as const)(
  "hides guest controls for a temporary thread known by %s and restores them after Keep",
  (source) => {
    const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(source));
    onTestFinished(() => forgetTemporaryThread(ref.environmentId, ref.threadId));
    fixtures.reads.length = 0;
    fixtures.registry.set(fixtures.shells(ref.threadId), { temporary: source === "shell" });
    if (source === "registry") setTemporaryThread(ref.environmentId, ref.threadId, true);

    expect(useThreadGuestShare(ref)).toBeNull();
    expect(fixtures.reads).toEqual([]);
    const [shareAtom] = vi.mocked(useAtomValue).mock.calls.at(-1)!;
    onTestFinished(fixtures.registry.mount(shareAtom));

    setTemporaryThread(ref.environmentId, ref.threadId, false);
    fixtures.registry.set(fixtures.shells(ref.threadId), { temporary: false });
    expect(fixtures.registry.get(shareAtom)).toEqual({ id: ref.threadId });
    expect(fixtures.reads).toEqual([ref.threadId]);
  },
);
