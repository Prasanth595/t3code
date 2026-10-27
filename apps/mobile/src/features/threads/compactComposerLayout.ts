const WIDE_COMPOSER_ROW_WIDTH = 500;

export function isWideComposerRow(rowWidth: number): boolean {
  return rowWidth >= WIDE_COMPOSER_ROW_WIDTH;
}

interface CompactComposerSlot {
  readonly rowWidth: number;
  /** The editor's collapsed width, or 0 until it is measured again. */
  readonly compactWidth: number;
  readonly label: { readonly width: number; readonly isExpanded: boolean };
}

export const EMPTY_COMPACT_COMPOSER_SLOT: CompactComposerSlot = {
  rowWidth: 0,
  compactWidth: 0,
  label: { width: 0, isExpanded: false },
};

/** A new row width forgets the compact slot so the next collapsed layout re-measures it. */
export function compactSlotAfterRowLayout(
  slot: CompactComposerSlot,
  rowWidth: number,
): CompactComposerSlot {
  return rowWidth === slot.rowWidth ? slot : { ...slot, rowWidth, compactWidth: 0 };
}

/**
 * A label shown at rest shares the row with the compact slot, which is only measured while
 * collapsed, so a label that resizes while the card stays open forgets it. Layouts that
 * open or close the card only record the width: resetting on them would loop.
 */
export function compactSlotAfterLabelLayout(
  slot: CompactComposerSlot,
  label: { readonly width: number; readonly isExpanded: boolean; readonly shownAtRest: boolean },
): CompactComposerSlot {
  const previous = slot.label;
  if (previous.width === label.width && previous.isExpanded === label.isExpanded) return slot;
  const resizedWhileOpen = label.shownAtRest && label.isExpanded && previous.isExpanded;
  return {
    ...slot,
    label: { width: label.width, isExpanded: label.isExpanded },
    compactWidth: resizedWhileOpen ? 0 : slot.compactWidth,
  };
}

export function resolveCompactComposerLayout(input: {
  readonly slot: CompactComposerSlot;
  readonly isFocused: boolean;
  readonly isAndroid: boolean;
  /** Android's Back hides the keyboard without blurring the editor. */
  readonly keyboardShowing: boolean;
  readonly keepsSettingsOpen: boolean;
  readonly value: string;
  readonly contentSize: { readonly width: number; readonly height: number };
  readonly lineHeight: number;
  readonly fontSize: number;
  /** Thumbnails shown inside the collapsed row, beside the model control. */
  readonly rowAttachmentCount: number;
}): {
  readonly isExpanded: boolean;
  readonly modelIconOnly: boolean;
  readonly labelShownAtRest: boolean;
} {
  const { rowWidth, compactWidth } = input.slot;
  const isWide = isWideComposerRow(rowWidth);
  const opensOnFocus =
    rowWidth > 0 &&
    !isWide &&
    ((input.isFocused && (!input.isAndroid || input.keyboardShowing)) || input.keepsSettingsOpen);
  const wraps = input.contentSize.height > input.lineHeight * 1.5;
  // A line that fits the expanded editor may still overflow its compact slot.
  // Compare its measured width too, a character early, so widening cannot loop.
  const fillsSlot = compactWidth > 0 && input.contentSize.width > compactWidth - input.fontSize;
  const isExpanded = opensOnFocus || (input.value.length > 0 && (wraps || fillsSlot));
  const labelShownAtRest = isWide && input.rowAttachmentCount === 0;
  return { isExpanded, modelIconOnly: !isExpanded && !labelShownAtRest, labelShownAtRest };
}
