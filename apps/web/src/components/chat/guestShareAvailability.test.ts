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
  return {
    registry: AtomRegistry.make(),
    configs: Atom.make(new Map<string, { settings: { guestSharingEnabled: boolean } }>()),
    permissions: Atom.family<string, Atom.Writable<boolean>>(() => Atom.make(true)),
    shells: Atom.family<string, Atom.Writable<{ temporary: boolean } | null>>(() =>
      Atom.make<{ temporary: boolean } | null>(null),
    ),
  };
});

vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: fixtures.registry }));
vi.mock("~/state/presentation", () => ({
  environmentPresentations: { serverConfigsAtom: fixtures.configs },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { createGuestShare: { permissionAtom: fixtures.permissions } },
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: {
    quietThreadShellAtom: (ref: ScopedThreadRef) => fixtures.shells(ref.threadId),
  },
}));

import { canShareWithGuestAtom } from "./guestShareAvailability";
import { guestShareDialogThreadAtom, openGuestShareDialog } from "./guestShareDialogState";

function setup(id: string) {
  const ref = scopeThreadRef(EnvironmentId.make(id), ThreadId.make(id));
  fixtures.registry.set(guestShareDialogThreadAtom, null);
  fixtures.registry.set(
    fixtures.configs,
    new Map([[ref.environmentId, { settings: { guestSharingEnabled: true } }]]),
  );
  fixtures.registry.set(fixtures.shells(ref.threadId), { temporary: false });
  onTestFinished(() => forgetTemporaryThread(ref.environmentId, ref.threadId));
  return ref;
}

it("reuses availability for the same environment and thread across reference objects", () => {
  const ref = setup("identity");
  const available = canShareWithGuestAtom(ref);

  expect(canShareWithGuestAtom(scopeThreadRef(ref.environmentId, ref.threadId))).toBe(available);
  expect(canShareWithGuestAtom(scopeThreadRef(EnvironmentId.make("other"), ref.threadId))).not.toBe(
    available,
  );
  expect(canShareWithGuestAtom(scopeThreadRef(ref.environmentId, ThreadId.make("other")))).not.toBe(
    available,
  );
});

it.each(["shell", "registry"] as const)(
  "refuses to open the guest share dialog for a temporary thread known by %s",
  (source) => {
    const ref = setup(source);
    fixtures.registry.set(fixtures.shells(ref.threadId), { temporary: source === "shell" });
    if (source === "registry") setTemporaryThread(ref.environmentId, ref.threadId, true);

    openGuestShareDialog(ref);

    expect(fixtures.registry.get(guestShareDialogThreadAtom)).toBeNull();
    expect(fixtures.registry.get(canShareWithGuestAtom(ref))).toBe(false);
  },
);

it("keeps saved sharing enabled beside a temporary thread and enables sharing after Keep", () => {
  const saved = setup("saved");
  const temporary = scopeThreadRef(saved.environmentId, ThreadId.make("temporary"));
  onTestFinished(() => forgetTemporaryThread(temporary.environmentId, temporary.threadId));
  setTemporaryThread(temporary.environmentId, temporary.threadId, true);
  fixtures.registry.set(fixtures.shells(temporary.threadId), { temporary: true });
  const available = canShareWithGuestAtom(temporary);
  onTestFinished(fixtures.registry.mount(available));
  expect(fixtures.registry.get(available)).toBe(false);

  openGuestShareDialog(saved);
  expect(fixtures.registry.get(guestShareDialogThreadAtom)).toEqual(saved);

  setTemporaryThread(temporary.environmentId, temporary.threadId, false);
  fixtures.registry.set(fixtures.shells(temporary.threadId), { temporary: false });
  expect(fixtures.registry.get(available)).toBe(true);
  openGuestShareDialog(temporary);
  expect(fixtures.registry.get(guestShareDialogThreadAtom)).toEqual(temporary);
});

it.each(["permission", "beta"] as const)("respects the destination %s gate", (gate) => {
  const ref = setup(gate);
  const available = canShareWithGuestAtom(ref);
  onTestFinished(fixtures.registry.mount(available));
  expect(fixtures.registry.get(available)).toBe(true);
  if (gate === "permission") {
    fixtures.registry.set(fixtures.permissions(ref.environmentId), false);
  } else {
    fixtures.registry.set(
      fixtures.configs,
      new Map([[ref.environmentId, { settings: { guestSharingEnabled: false } }]]),
    );
  }

  expect(fixtures.registry.get(available)).toBe(false);
  openGuestShareDialog(ref);
  expect(fixtures.registry.get(guestShareDialogThreadAtom)).toBeNull();
});

it("does not offer sharing before a thread is admitted by the shell", () => {
  const pending = setup("pending");
  fixtures.registry.set(fixtures.shells(pending.threadId), null);

  openGuestShareDialog(pending);

  expect(fixtures.registry.get(guestShareDialogThreadAtom)).toBeNull();
  expect(fixtures.registry.get(canShareWithGuestAtom(null))).toBe(false);
});
