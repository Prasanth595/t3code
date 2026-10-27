export const WIDE_COMPOSER_ROW_WIDTH = 500;

export function isWideComposerRow(rowWidth: number): boolean {
  return rowWidth >= WIDE_COMPOSER_ROW_WIDTH;
}

export interface CompactComposerSlot {
  readonly rowWidth: number;
  /** The editor's collapsed width, or 0 until it is measured at this row width. */
  readonly compactWidth: number;
}

/** A new row width forgets the compact slot so the next collapsed layout re-measures it. */
export function compactSlotAfterRowLayout(
  slot: CompactComposerSlot,
  rowWidth: number,
): CompactComposerSlot {
  return rowWidth === slot.rowWidth ? slot : { rowWidth, compactWidth: 0 };
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
}): { readonly isExpanded: boolean; readonly modelIconOnly: boolean } {
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
  return {
    isExpanded,
    modelIconOnly: !isExpanded && (!isWide || input.rowAttachmentCount > 0),
  };
}
