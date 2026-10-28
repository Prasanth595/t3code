import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { threadFamilies } from "../../state/threads";
import { ThreadContextChip } from "../ThreadContextChip";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const mocks = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    shells: Atom.make<ReadonlyMap<string, OrchestrationV2ThreadShell>>(new Map()).pipe(
      Atom.keepAlive,
    ),
    reads: Atom.family((_key: string) =>
      Atom.make<AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, never>>(
        AsyncResult.initial(),
      ).pipe(Atom.keepAlive),
    ),
  };
});

const key = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);

vi.mock("../../state/entities", () => ({
  useProject: () => null,
  useThreadRefs: () => [],
  useThreadShell: (ref: ScopedThreadRef | null) => {
    const rows = useAtomValue(mocks.shells);
    if (ref === null) return null;
    const row = rows.get(key(ref));
    return row ? { ...row, environmentId: ref.environmentId } : null;
  },
}));

vi.mock("../contextChipParts", () => ({
  UnresolvedChip: ({ label }: { label: string }) => <span>{label}</span>,
}));

vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

const ENV = EnvironmentId.make("thread-links-test");
const ref = (id: string, environmentId = ENV): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(id),
});
const row = (id: string, title: string) =>
  ({ id: ThreadId.make(id), title }) as OrchestrationV2ThreadShell;

function setup(shells: ReadonlyMap<string, OrchestrationV2ThreadShell> = new Map()) {
  appAtomRegistry.set(mocks.shells, shells);
  const mounted = new Map<string, OrchestrationV2ThreadFamily>();
  const counts = new Map<string, number>();
  const requested = new Set<string>();
  const queries = vi
    .spyOn(threadFamilies, "familyAtom")
    .mockImplementation((environmentId, threadId) => {
      const id = key({ environmentId, threadId });
      if (!requested.has(id)) {
        requested.add(id);
        appAtomRegistry.set(mocks.reads(id), AsyncResult.initial());
      }
      return mocks.reads(id);
    });
  const mounts = vi
    .spyOn(threadFamilies, "mount")
    .mockImplementation((registry, environmentId, threadId) => {
      const id = key({ environmentId, threadId });
      const query = threadFamilies.familyAtom(environmentId, threadId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const publish = () => {
        const rows = new Map(shells);
        for (const [familyKey, family] of mounted) {
          const [environmentId] = JSON.parse(familyKey) as [EnvironmentId, ThreadId];
          for (const thread of family.threads) {
            rows.set(key({ environmentId, threadId: thread.id }), thread);
          }
        }
        registry.set(mocks.shells, rows);
      };
      const unsubscribe = registry.subscribe(
        query,
        (result) => {
          if (AsyncResult.isSuccess(result)) mounted.set(id, result.value);
          else mounted.delete(id);
          publish();
        },
        { immediate: true },
      );
      return () => {
        unsubscribe();
        const count = (counts.get(id) ?? 1) - 1;
        counts.set(id, count);
        if (count === 0) mounted.delete(id);
        publish();
      };
    });
  return {
    requested,
    resolve: (target: ScopedThreadRef, threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
      act(() =>
        appAtomRegistry.set(
          mocks.reads(key(target)),
          AsyncResult.success({ snapshotSequence: 1, threads }),
        ),
      ),
    [Symbol.dispose]() {
      mounts.mockRestore();
      queries.mockRestore();
    },
  };
}

function view(target: ScopedThreadRef, kind: "context" | "markdown" = "markdown") {
  return (
    <AppAtomRegistryProvider>
      {kind === "context" ? (
        <ThreadContextChip record={{ ...target, title: "Saved title" }} />
      ) : (
        <MarkdownThreadLink environmentId={ENV} link={target} label={null} />
      )}
    </AppAtomRegistryProvider>
  );
}

describe("thread link family lookups", () => {
  it.each(["context", "markdown"] as const)(
    "retains a settled thread until its %s chip unmounts",
    async (kind) => {
      using fixture = setup();
      const target = ref("older-settled");
      await using screen = await render(view(target, kind));
      await fixture.resolve(target, [row(target.threadId, "Older settled thread")]);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Older settled thread" }))
        .toBeInTheDocument();
      await screen.rerender(view(target, kind));
      await expect
        .element(screen.getByRole("link", { name: "Thread, Older settled thread" }))
        .toBeInTheDocument();
      expect(appAtomRegistry.get(mocks.shells).has(key(target))).toBe(true);
      await screen.unmount();
      expect(appAtomRegistry.get(mocks.shells).size).toBe(0);
    },
  );

  it("prefers a literal percent escape to the decoded thread", async () => {
    const literal = ref("provider%3A1");
    const decoded = ref("provider:1");
    using fixture = setup(new Map([[key(decoded), row(decoded.threadId, "Decoded thread")]]));
    await using screen = await render(view(literal));
    await expect
      .element(screen.getByRole("link", { name: "Thread, Decoded thread" }))
      .not.toBeInTheDocument();
    expect(fixture.requested.has(key(literal))).toBe(true);
    expect(fixture.requested.has(key(decoded))).toBe(false);
    await fixture.resolve(literal, [row(literal.threadId, "Literal thread")]);
    await expect
      .element(screen.getByRole("link", { name: "Thread, Literal thread" }))
      .toBeInTheDocument();
    expect(fixture.requested.has(key(decoded))).toBe(false);
  });

  it("tries the decoded ID only after a successful empty literal lookup", async () => {
    using fixture = setup();
    const literal = ref("provider%3A1");
    const decoded = ref("provider:1");
    await using screen = await render(view(literal));
    expect(fixture.requested.has(key(decoded))).toBe(false);
    await fixture.resolve(literal, []);
    expect(fixture.requested.has(key(decoded))).toBe(true);
    await fixture.resolve(decoded, [row(decoded.threadId, "Decoded thread")]);
    await expect
      .element(screen.getByRole("link", { name: "Thread, Decoded thread" }))
      .toBeInTheDocument();
  });

  it("releases the previous family when the target environment changes", async () => {
    using fixture = setup();
    const first = ref("same-id");
    const second = ref("same-id", EnvironmentId.make("second-environment"));
    await using screen = await render(view(first));
    await fixture.resolve(first, [row(first.threadId, "First environment")]);
    await screen.rerender(view(second));
    await fixture.resolve(second, [row(second.threadId, "Second environment")]);
    await expect
      .element(screen.getByRole("link", { name: "Thread, Second environment" }))
      .toBeInTheDocument();
    expect(appAtomRegistry.get(mocks.shells).has(key(first))).toBe(false);
  });
});
