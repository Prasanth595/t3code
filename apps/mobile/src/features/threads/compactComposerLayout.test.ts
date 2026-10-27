import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_COMPACT_COMPOSER_SLOT,
  compactSlotAfterLabelLayout,
  compactSlotAfterRowLayout,
  resolveCompactComposerLayout,
} from "./compactComposerLayout";

const LINE_HEIGHT = 22;
const FONT_SIZE = 16;
const NARROW = 360;
const WIDE = 700;

function composer(
  input: {
    readonly rowWidth?: number;
    readonly isFocused?: boolean;
    readonly isAndroid?: boolean;
    readonly keyboardVisible?: boolean;
    readonly keepsSettingsOpen?: boolean;
    readonly value?: string;
    readonly contentSize?: { readonly width: number; readonly height: number };
    readonly compactWidth?: number;
    readonly attachmentCount?: number;
  } = {},
) {
  const { isExpanded, modelIconOnly } = resolveCompactComposerLayout({
    slot: {
      ...EMPTY_COMPACT_COMPOSER_SLOT,
      rowWidth: input.rowWidth ?? NARROW,
      compactWidth: input.compactWidth ?? 200,
    },
    isFocused: input.isFocused ?? false,
    isAndroid: input.isAndroid ?? false,
    keyboardShowing: input.keyboardVisible ?? false,
    keepsSettingsOpen: input.keepsSettingsOpen ?? false,
    value: input.value ?? "",
    contentSize: input.contentSize ?? { width: 0, height: LINE_HEIGHT },
    lineHeight: LINE_HEIGHT,
    fontSize: FONT_SIZE,
    rowAttachmentCount: input.attachmentCount ?? 0,
  });
  return { isExpanded, modelIconOnly };
}

describe("compact composer layout", () => {
  it("opens the card with the model label when a narrow composer is focused", () => {
    expect(composer()).toEqual({ isExpanded: false, modelIconOnly: true });
    expect(composer({ isFocused: true })).toEqual({ isExpanded: true, modelIconOnly: false });
    expect(composer({ isFocused: true, isAndroid: true }).isExpanded).toBe(false);
    expect(composer({ isFocused: true, isAndroid: true, keyboardVisible: true }).isExpanded).toBe(
      true,
    );
    expect(composer({ keepsSettingsOpen: true })).toEqual({
      isExpanded: true,
      modelIconOnly: false,
    });
  });

  it("shows the model label at rest on a wide row and keeps focus in the row", () => {
    expect(composer({ rowWidth: WIDE })).toEqual({ isExpanded: false, modelIconOnly: false });
    expect(composer({ rowWidth: WIDE, isFocused: true }).isExpanded).toBe(false);
    expect(composer({ rowWidth: WIDE, keepsSettingsOpen: true }).isExpanded).toBe(false);
    expect(composer({ rowWidth: WIDE, attachmentCount: 1 }).modelIconOnly).toBe(true);
  });

  it("opens a wide row's card about one character before the line fills its slot", () => {
    const draft = { rowWidth: WIDE, value: "draft", compactWidth: 400 };
    expect(composer({ ...draft, contentSize: { width: 380, height: LINE_HEIGHT } })).toEqual({
      isExpanded: false,
      modelIconOnly: false,
    });
    expect(composer({ ...draft, contentSize: { width: 390, height: LINE_HEIGHT } })).toEqual({
      isExpanded: true,
      modelIconOnly: false,
    });
    expect(
      composer({ ...draft, contentSize: { width: 100, height: LINE_HEIGHT * 2 } }).isExpanded,
    ).toBe(true);
  });

  it("re-measures the compact slot when the row widens so the card can close", () => {
    const narrowSlot = { ...EMPTY_COMPACT_COMPOSER_SLOT, rowWidth: NARROW, compactWidth: 200 };
    const line = { value: "a single line draft", contentSize: { width: 300, height: LINE_HEIGHT } };
    expect(composer({ ...line, rowWidth: NARROW, compactWidth: narrowSlot.compactWidth })).toEqual({
      isExpanded: true,
      modelIconOnly: false,
    });

    const widened = compactSlotAfterRowLayout(narrowSlot, WIDE);
    expect(compactSlotAfterRowLayout(widened, WIDE)).toBe(widened);
    expect(composer({ ...line, rowWidth: WIDE, compactWidth: widened.compactWidth })).toEqual({
      isExpanded: false,
      modelIconOnly: false,
    });
  });

  it("re-measures a wide row's slot when the label shrinks while the card is open", () => {
    const line = {
      rowWidth: WIDE,
      value: "a long draft",
      contentSize: { width: 330, height: LINE_HEIGHT },
    };
    const label = { isExpanded: true, shownAtRest: true };
    let slot = { ...EMPTY_COMPACT_COMPOSER_SLOT, rowWidth: WIDE, compactWidth: 320 };
    slot = compactSlotAfterLabelLayout(slot, { ...label, width: 200, isExpanded: false });
    slot = compactSlotAfterLabelLayout(slot, { ...label, width: 200 });
    expect(composer({ ...line, compactWidth: slot.compactWidth }).isExpanded).toBe(true);

    // Opening and closing the card resizes a truncated label without resetting the slot.
    slot = compactSlotAfterLabelLayout(slot, { ...label, width: 240, isExpanded: false });
    slot = compactSlotAfterLabelLayout(slot, { ...label, width: 200 });
    expect(slot.compactWidth).toBe(320);

    slot = compactSlotAfterLabelLayout(slot, { ...label, width: 160 });
    expect(composer({ ...line, compactWidth: slot.compactWidth }).isExpanded).toBe(false);
  });
});
