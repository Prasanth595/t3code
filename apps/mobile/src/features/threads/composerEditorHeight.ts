/** Fits the editor above its toolbar without letting attachments push it offscreen. */
export function composerEditorHeight(input: {
  contentHeight: number;
  availableHeight: number;
  lineHeight: number;
}) {
  const maximum = Math.max(input.lineHeight + 8, input.availableHeight);
  const inlineMaximum = Math.max(
    input.lineHeight + 8,
    Math.min(maximum, input.lineHeight * 9 + 8, maximum * 0.7),
  );
  const minimum = Math.min(input.lineHeight * 3 + 8, inlineMaximum);
  return Math.min(inlineMaximum, Math.max(minimum, Math.ceil(input.contentHeight) + 8));
}
