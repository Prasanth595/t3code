import type { SensorProps } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { SidebarDraftBlock } from "./sidebar/SidebarDraftBlock";
import { act, render, fakeTimers } from "../../test/render";
import { SidebarPointerSensor } from "./Sidebar.pointer";

const sensors: SidebarPointerSensor[] = [];

function pointer(type: string, values: PointerEventInit = {}) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    buttons: 1,
    ...values,
  });
}

function gesture(
  extraOptions: Partial<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]> = {},
) {
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const onFinish = vi.fn();
  const props = {
    active: "thread",
    event: pointer("pointerdown"),
    options: { distance: 6, onAttach: vi.fn(), onFinish, ...extraOptions },
    ...callbacks,
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>;
  const sensor = new SidebarPointerSensor(props);
  sensors.push(sensor);
  return { sensor, onFinish, ...callbacks };
}

function setup() {
  const stack = new DisposableStack();
  stack.use(fakeTimers());
  stack.defer(() => {
    for (const sensor of sensors.splice(0)) sensor.cancel();
    // Cancelled sensors keep suppressing clicks on the shared document until the next press.
    document.dispatchEvent(pointer("pointerdown"));
    vi.runAllTimers();
  });
  return stack;
}

describe("sidebar pointer lifecycle", () => {
  it("drops context when a zero-button move precedes pointerup", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));

    // Native desktop releases can report the released button on the final move.
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 100, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 94, y: 32 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  // regression: #17373 a zero-button release outside a drop target must cancel, not reorder
  it("cancels a missed sidebar release without committing a reorder", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 30, clientY: 40 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 40 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });
});

it("keeps draft actions separate from keyboard navigation and anchors keyboard menus to the row", async () => {
  const draftId = DraftId.make("accessible-draft");
  const environmentId = EnvironmentId.make("sidebar-test");
  const projectId = ProjectId.make("project-test");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId);
  store.setPrompt(draftId, "Fix tests");
  using _cleanup = {
    [Symbol.dispose]: () => useComposerDraftStore.getState().clearDraftThread(draftId),
  };
  const onNavigate = vi.fn();
  const onContextMenu = vi.fn();
  await using screen = await render(
    <ul>
      <SidebarDraftBlock
        projectByKey={new Map()}
        projectDisplayNameByKey={new Map()}
        scopedProjectKeys={null}
        routeDraftId={null}
        onNavigateToDraft={onNavigate}
        onDraftContextMenu={onContextMenu}
      />
    </ul>,
  );
  const primary = screen.getByRole("button", { name: "Fix tests, Unsent draft", exact: true });
  const discard = screen.getByRole("button", { name: "Discard draft", exact: true });
  expect(primary.element()).toBeInstanceOf(HTMLButtonElement);
  expect(discard.element().parentElement?.closest('button, [role="button"]')).toBeNull();
  await act(() => (primary.element() as HTMLElement).focus());
  await userEvent.keyboard("{Enter}");
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith(draftId);
  await userEvent.tab();
  expect(discard.element()).toHaveFocus();
  await act(() => (primary.element() as HTMLElement).focus());
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  const row = screen.container.querySelector('[data-testid="sidebar-draft-row"]')!;
  const bounds = row.getBoundingClientRect();
  expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(draftId, {
    x: bounds.left,
    y: bounds.bottom,
  });
  onContextMenu.mockClear();
  await userEvent.keyboard("{ContextMenu}");
  expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(draftId, {
    x: bounds.left,
    y: bounds.bottom,
  });
  onContextMenu.mockClear();
  await act(() =>
    primary
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(draftId, {
    x: bounds.left,
    y: bounds.bottom,
  });
  await act(() => (discard.element() as HTMLElement).focus());
  await userEvent.keyboard(" ");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith(draftId);
});
