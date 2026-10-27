export const WIDE_COMPOSER_ROW_WIDTH = 500;

export function isWideComposerRow(rowWidth: number): boolean {
  return rowWidth >= WIDE_COMPOSER_ROW_WIDTH;
}

/** Whether focus or the settings sheet opens the card, before the draft is considered. */
export function composerOpensCardOnFocus(input: {
  readonly rowWidth: number;
  readonly isFocused: boolean;
  readonly isAndroid: boolean;
  readonly keyboardVisible: boolean;
  readonly keepsSettingsOpen: boolean;
}): boolean {
  const opensCard =
    (input.isFocused && (!input.isAndroid || input.keyboardVisible)) || input.keepsSettingsOpen;
  return opensCard && input.rowWidth > 0 && !isWideComposerRow(input.rowWidth);
}

export function isCompactComposerExpanded(input: {
  readonly opensOnFocus: boolean;
  readonly value: string;
  readonly contentSize: { readonly width: number; readonly height: number };
  readonly compactWidth: number;
  readonly lineHeight: number;
  readonly fontSize: number;
}): boolean {
  const wraps = input.contentSize.height > input.lineHeight * 1.5;
  // A line that fits the expanded editor may still overflow its compact slot.
  // Compare its measured width too so widening cannot trigger a collapse loop.
  return (
    input.opensOnFocus ||
    (input.value.length > 0 &&
      (wraps ||
        (input.compactWidth > 0 && input.contentSize.width > input.compactWidth - input.fontSize)))
  );
}

/** A new row width forgets the compact slot so the next collapsed layout re-measures it. */
export function compactSlotAfterRowLayout(
  slot: { readonly rowWidth: number; readonly compactWidth: number },
  rowWidth: number,
): { readonly rowWidth: number; readonly compactWidth: number } {
  return rowWidth === slot.rowWidth ? slot : { rowWidth, compactWidth: 0 };
}

export function composerModelIconOnly(input: {
  readonly isExpanded: boolean;
  readonly rowWidth: number;
  readonly attachmentCount: number;
}): boolean {
  return !input.isExpanded && (!isWideComposerRow(input.rowWidth) || input.attachmentCount > 0);
}
