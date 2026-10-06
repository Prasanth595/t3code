import type { LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { View, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { getPendingThreadOrder, threadDropBusyAtom } from "../../state/thread-order";
import { environmentThreadShells } from "../../state/threads";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import {
  resolveThreadDrop,
  threadDragGapOffset,
  threadDropInsertionOffset,
  type ThreadDragRow,
  type ThreadDropDestination,
} from "./threadDragGap";
import {
  getThreadListV2OrderedSection,
  isThreadListV2ListItem,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { createThreadMovePlanner, threadDragAction, type ThreadDragSection } from "./threadOrder";

// Long enough that a flick still scrolls, short enough to beat the long-press
// menu (~500ms on iOS): holding still opens the menu, moving after the hold
// lifts the row.
const HOLD_MS = 200;
const PRESS_SLOP = 10;
const LIFT_SLOP = 6;
const AUTO_SCROLL_EDGE = 56;

type ListItem = { readonly type: string; readonly key: string };
type ListState = ReturnType<LegendListRef["getState"]>;

/** Published to rows so they can slide aside for the insertion gap. */
interface DragLayout {
  readonly sourceKey: string;
  readonly sourceOffset: number;
  readonly sourceHeight: number;
  readonly insertionOffset: number;
  readonly offsets: Readonly<Record<string, number>>;
}

interface Drag {
  readonly itemKey: string;
  readonly thread: EnvironmentThreadShell;
  readonly section: ThreadDragSection;
  readonly grabY: number;
  /** The finger's content Y is `anchor + absoluteY + scroll`. */
  readonly anchor: number;
  readonly minimumScroll: number;
  readonly canDrop: (destination: ThreadDropDestination) => boolean;
  absoluteY: number;
  /** Undefined until the first resolution is published. */
  destination: ThreadDropDestination | null | undefined;
}

export interface ThreadListDragListProps {
  readonly alwaysRender?: { readonly keys: string[] };
}

interface Controller {
  canStart(): boolean;
  arm(itemKey: string): void;
  disarm(): void;
  start(itemKey: string, thread: EnvironmentThreadShell, grabY: number, absoluteY: number): void;
  move(absoluteY: number): void;
  end(cancelled: boolean): void;
}

/** Handed to each row of a list that uses `useThreadListDrag`. */
export interface ThreadListDragTarget {
  readonly controller: Controller;
  readonly layout: SharedValue<DragLayout | null>;
}

function dragSection(item: ThreadListV2ListItem): ThreadDragSection | null {
  if (item.type === "v2-settled-shelf") return "settled";
  if (item.type !== "v2-thread") return null;
  if (item.item.snoozed) return "snoozed";
  if (item.item.variant === "slim") return "settled";
  return item.item.pinned ? "pinned" : "active";
}

/** The list's untransformed layout. The gap is a transform, so hit testing
 * never sees it. LegendList only reports sizes for measured rows. */
function snapshotRows(state: ListState, items: readonly ListItem[], estimatedRowHeight: number) {
  const rows: ThreadDragRow[] = [];
  const offsets: Record<string, number> = {};
  let cursor = 0;
  items.forEach((item, index) => {
    const position = state.positionAtIndex(index);
    const offset = Number.isFinite(position) ? position : cursor;
    const next = state.positionAtIndex(index + 1);
    const height =
      state.sizes.get(item.key) ??
      (Number.isFinite(next) && next > offset ? next - offset : estimatedRowHeight);
    cursor = offset + height;
    offsets[item.key] = offset;
    if (!isThreadListV2ListItem(item)) return;
    rows.push({
      key: item.key,
      threadKey:
        item.type === "v2-thread"
          ? scopedThreadKey(item.item.thread.environmentId, item.item.thread.id)
          : null,
      section: dragSection(item),
      offset,
      height,
    });
  });
  return { rows, offsets };
}

/** Plan against the complete sections, exactly as the drop's `moveThread` will. */
function createDropPolicy(
  thread: EnvironmentThreadShell,
  section: ThreadDragSection,
  workingShelfEnabled: boolean,
) {
  const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const capabilities = (id: EnvironmentThreadShell["environmentId"]) =>
    configs.get(id)?.environment.capabilities;
  const environmentsWhere = (supported: (id: EnvironmentThreadShell["environmentId"]) => boolean) =>
    new Set([...configs.keys()].filter(supported));
  const planner = (destination: "pinned" | "active") =>
    createThreadMovePlanner({
      ordered: getThreadListV2OrderedSection({
        threads: shells,
        section: destination,
        now: new Date().toISOString(),
        queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
        settlementEnvironmentIds: environmentsWhere((id) => !!capabilities(id)?.threadSettlement),
        snoozeEnvironmentIds: environmentsWhere((id) => !!capabilities(id)?.threadSnooze),
      }),
      allThreads: shells,
      section: destination,
      // The Working beta orders Active by time, so only pins take a position.
      reorderableEnvironmentIds: environmentsWhere((id) =>
        destination === "pinned"
          ? !!capabilities(id)?.threadPinReorder
          : !workingShelfEnabled && !!capabilities(id)?.threadActiveReorder,
      ),
    });
  const planners = { pinned: planner("pinned"), active: planner("active") };
  const own = capabilities(thread.environmentId);
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  return (destination: ThreadDropDestination) => {
    const target = destination.section;
    if (target === undefined) return false;
    if (target === "settled") return !!own?.threadSettlement;
    const pinChange = target !== section && (target === "pinned" || section === "pinned");
    if (pinChange && !own?.threadPinning) return false;
    return planners[target](threadKey, destination) !== null;
  };
}

/**
 * Press-and-drag arrangement for a thread list. Spread `listProps` onto the
 * list, render `overlay` beside it, and pass `target` to each row.
 */
export function useThreadListDrag(props: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly estimatedRowHeight: number;
  readonly items: readonly ListItem[];
  readonly workingShelfEnabled: boolean;
  /** Content under translucent chrome, kept out of the auto-scroll edges. */
  readonly edgeInsets?:
    | { readonly top: number; readonly bottom: number; readonly scrollInsetTop?: number }
    | undefined;
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    destination: ThreadDropDestination,
  ) => Promise<boolean>;
}) {
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    title: string;
    height: number;
    action: string | null;
  }>();
  const layout = useSharedValue<DragLayout | null>(null);
  const previewTop = useSharedValue(0);
  const viewport = useRef({ top: 0, height: 0 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const { controller, cancel } = useMemo(() => {
    const insets = () => latest.current.edgeInsets ?? { top: 0, bottom: 0 };
    const cancel = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      drag.current = null;
      layout.set(null);
      setPreview(undefined);
    };
    // Rows are measured as auto-scroll reveals them, so each resolution reads
    // LegendList's current layout and the scroll offset it actually applied.
    const retarget = () => {
      const current = drag.current;
      const list = latest.current.listRef.current;
      if (current === null || list === null) return;
      const state = list.getState();
      const { rows, offsets } = snapshotRows(state, latest.current.items, latest.current.estimatedRowHeight);
      const destination = resolveThreadDrop({
        rows,
        contentY: current.anchor + current.absoluteY + state.scroll,
        source: {
          threadKey: scopedThreadKey(current.thread.environmentId, current.thread.id),
          section: current.section,
        },
        canDrop: current.canDrop,
      });
      const previous = current.destination;
      if (
        previous !== undefined &&
        destination?.section === previous?.section &&
        destination?.targetId === previous?.targetId &&
        destination?.placement === previous?.placement
      )
        return;
      current.destination = destination;
      const source = rows.find((row) => row.key === current.itemKey);
      const sourceOffset = source?.offset ?? 0;
      const sourceHeight = source?.height ?? latest.current.estimatedRowHeight;
      layout.set({
        sourceKey: current.itemKey,
        sourceOffset,
        sourceHeight,
        insertionOffset: threadDropInsertionOffset(rows, destination, sourceOffset),
        offsets,
      });
      setPreview({
        title: current.thread.title,
        height: sourceHeight,
        action: destination?.section
          ? threadDragAction(current.section, destination.section)
          : null,
      });
    };
    const autoScroll = () => {
      let last = performance.now();
      const tick = () => {
        const current = drag.current;
        const list = latest.current.listRef.current;
        if (current === null || list === null) return;
        const now = performance.now();
        const elapsed = Math.min(now - last, 32);
        last = now;
        const y = current.absoluteY - viewport.current.top;
        const top = insets().top + AUTO_SCROLL_EDGE;
        const bottom = viewport.current.height - insets().bottom - AUTO_SCROLL_EDGE;
        const speed =
          y < top
            ? -Math.min(1, (top - y) / AUTO_SCROLL_EDGE)
            : y > bottom
              ? Math.min(1, (y - bottom) / AUTO_SCROLL_EDGE)
              : 0;
        if (speed !== 0) {
          const state = list.getState();
          const maximum = Math.max(state.scroll, state.contentLength - state.scrollLength);
          const scroll = Math.max(
            current.minimumScroll,
            Math.min(maximum, state.scroll + speed * elapsed * 0.5),
          );
          // LegendList's scrollToOffset clamps the negative offset iOS
          // automatic insets rest at; the native view does not.
          if (Math.abs(scroll - state.scroll) >= 0.5)
            list.getNativeScrollRef()?.scrollTo({ y: scroll, animated: false });
        }
        retarget();
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    };
    const controller: Controller = {
      canStart: () =>
        drag.current === null &&
        getPendingThreadOrder() === null &&
        !appAtomRegistry.get(threadDropBusyAtom),
      arm: (itemKey) => {
        setHeldKey(itemKey);
        latest.current.listRef.current
          ?.getNativeScrollRef()
          ?.measureInWindow((_x: number, y: number, _width: number, height: number) => {
            viewport.current = { top: y, height };
          });
      },
      disarm: () => setHeldKey(null),
      start: (itemKey, thread, grabY, absoluteY) => {
        const list = latest.current.listRef.current;
        if (list === null || drag.current !== null) return;
        const state = list.getState();
        const source = snapshotRows(state, latest.current.items, latest.current.estimatedRowHeight).rows.find(
          (row) => row.key === itemKey,
        );
        if (source?.section !== "pinned" && source?.section !== "active") return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        drag.current = {
          itemKey,
          thread,
          section: source.section,
          grabY,
          anchor: source.offset + grabY - absoluteY - state.scroll,
          minimumScroll: Math.min(
            state.scroll,
            -(latest.current.edgeInsets?.scrollInsetTop ?? insets().top),
          ),
          canDrop: createDropPolicy(thread, source.section, latest.current.workingShelfEnabled),
          absoluteY,
          destination: undefined,
        };
        retarget();
        autoScroll();
      },
      move: (absoluteY) => {
        const current = drag.current;
        if (current === null) return;
        current.absoluteY = absoluteY;
        // The lifted card stays clear of translucent chrome.
        const { top, height } = viewport.current;
        previewTop.set(
          Math.max(
            insets().top,
            Math.min(
              height - insets().bottom - (layout.get()?.sourceHeight ?? 0),
              absoluteY - top - current.grabY,
            ),
          ),
        );
        retarget();
      },
      end: (cancelled) => {
        const current = drag.current;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        if (current === null) return;
        if (cancelled || !current.destination) return cancel();
        // Keep the gap until the saved order arrives, avoiding a flash back.
        void latest.current.onMoveThread(current.thread, current.destination).finally(() => {
          if (drag.current === current) cancel();
        });
      },
    };
    return { controller, cancel };
  }, [layout, previewTop]);

  // A rebuilt list invalidates the drag, including a remote pin or settle
  // that keeps the order but changes what the drop would do.
  const listVersion = props.items
    .map((item) => (isThreadListV2ListItem(item) ? `${item.key}:${dragSection(item)}` : item.key))
    .join("|");
  useEffect(() => {
    if (drag.current !== null) cancel();
  }, [listVersion, cancel]);
  useEffect(() => cancel, [cancel]);

  const previewStyle = useAnimatedStyle(() => ({ transform: [{ translateY: previewTop.value }] }));
  const target = useMemo(() => ({ controller, layout }), [controller, layout]);
  const listProps = useMemo<ThreadListDragListProps>(
    () =>
      // Recycling the held cell would cancel its gesture mid-drag.
      heldKey === null ? {} : { alwaysRender: { keys: [heldKey] } },
    [heldKey],
  );
  const overlay = preview ? (
    <Reanimated.View
      pointerEvents="none"
      style={[
        { position: "absolute", top: 0, left: 12, right: 12, height: preview.height },
        previewStyle,
      ]}
    >
      <View className="flex-1 justify-center rounded-xl border border-border bg-screen px-4">
        <Text numberOfLines={preview.action ? 1 : 2} className="text-base font-t3-medium">
          {preview.title}
        </Text>
        {preview.action ? (
          <Text className="text-xs text-foreground-muted">{preview.action}</Text>
        ) : null}
      </View>
    </Reanimated.View>
  ) : null;
  return { target, listProps, overlay };
}

/**
 * Press-and-drag for one row. Attach `ref`, `gesture`, and `style` to the
 * row's outer view and call `onMenuOpen` when its long-press menu appears.
 */
export function useThreadListDragTarget(input: {
  readonly target: ThreadListDragTarget | undefined;
  readonly itemKey: string;
  readonly thread: EnvironmentThreadShell;
  readonly enabled: boolean;
}) {
  const fallbackLayout = useSharedValue<DragLayout | null>(null);
  const layout = input.target?.layout ?? fallbackLayout;
  const controller = input.target?.controller ?? null;
  const enabled = input.enabled && controller !== null;
  const row = useRef<ViewInstance>(null);
  const latest = useRef(input);
  latest.current = input;
  // Mutable press state lives in a ref: the compiler does not preserve
  // closure variables reassigned inside gesture callbacks.
  const press = useRef({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    armed: false,
    active: false,
    menuOpen: false,
    startX: 0,
    startY: 0,
    rowTop: 0,
    // The row this press began on; a recycled cell must not lift its new thread.
    itemKey: "",
    thread: input.thread,
  });

  const { gesture, release } = useMemo(() => {
    const state = press.current;
    const release = () => {
      clearTimeout(state.timer);
      state.timer = undefined;
      if (state.armed) controller?.disarm();
      state.armed = false;
    };
    const fail = (manager: { fail(): void }) => {
      if (state.active) return;
      release();
      manager.fail();
    };
    const gesture = Gesture.Pan()
      .enabled(enabled)
      .manualActivation(true)
      // An unreachable threshold stops the native pan from recognizing on its
      // own movement and taking the touch from the list's scroll view; only
      // `activate()` after the hold starts a drag.
      .minDistance(Number.MAX_SAFE_INTEGER)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onTouchesDown((event, manager) => {
        const touch = event.allTouches[0];
        if (event.numberOfTouches !== 1 || touch === undefined || !controller?.canStart())
          return manager.fail();
        Object.assign(state, {
          menuOpen: false,
          itemKey: latest.current.itemKey,
          thread: latest.current.thread,
          startX: touch.absoluteX,
          startY: touch.absoluteY,
        });
        state.timer = setTimeout(() => {
          state.timer = undefined;
          if (state.menuOpen) return;
          state.armed = true;
          // Gesture `y` is unreliable inside the list; the grab point comes
          // from the row's window position instead (synchronous on Fabric).
          row.current?.measureInWindow((_x, y) => {
            state.rowTop = y;
          });
          controller.arm(state.itemKey);
        }, HOLD_MS);
      })
      .onTouchesMove((event, manager) => {
        const touch = event.allTouches[0];
        if (state.active || touch === undefined) return;
        const distance = Math.hypot(touch.absoluteX - state.startX, touch.absoluteY - state.startY);
        if (
          state.menuOpen ||
          event.numberOfTouches !== 1 ||
          (!state.armed && distance > PRESS_SLOP)
        )
          fail(manager);
        else if (state.armed && distance > LIFT_SLOP) manager.activate();
      })
      .onTouchesUp((_event, manager) => fail(manager))
      .onTouchesCancelled((_event, manager) => fail(manager))
      .onStart((event) => {
        state.active = true;
        // Anchor to the touch-down point so the lift never jumps.
        controller?.start(state.itemKey, state.thread, state.startY - state.rowTop, state.startY);
        controller?.move(event.absoluteY);
      })
      .onUpdate((event) => controller?.move(event.absoluteY))
      .onFinalize((_event, success) => {
        if (state.active) controller?.end(!success);
        state.active = false;
        release();
      });
    return { gesture, release };
  }, [controller, enabled]);

  // A press must not outlive its row: restore scrolling if the cell is
  // recycled or unmounted while held.
  useEffect(() => release, [input.itemKey, release]);

  const itemKey = input.itemKey;
  const style = useAnimatedStyle(() => {
    const value = layout.value;
    const offset = value?.offsets[itemKey];
    if (value == null || offset === undefined)
      return { opacity: 1, transform: [{ translateY: 0 }] };
    const shift = threadDragGapOffset(
      offset,
      value.sourceOffset,
      value.sourceHeight,
      value.insertionOffset,
    );
    return {
      opacity: value.sourceKey === itemKey ? 0 : 1,
      transform: [
        { translateY: withTiming(shift, { duration: 160, reduceMotion: ReduceMotion.System }) },
      ],
    };
  });

  const onMenuOpen = useMemo(
    () => () => {
      press.current.menuOpen = true;
      release();
    },
    [release],
  );
  return { ref: row, gesture, style, onMenuOpen };
}

/** The row's outer view, carrying its drag gesture and gap offset. */
export function ThreadListDragRow(props: {
  readonly drag: ReturnType<typeof useThreadListDragTarget>;
  readonly children: ReactNode;
}) {
  return (
    <GestureDetector gesture={props.drag.gesture}>
      <Reanimated.View ref={props.drag.ref} collapsable={false} style={props.drag.style}>
        {props.children}
      </Reanimated.View>
    </GestureDetector>
  );
}
