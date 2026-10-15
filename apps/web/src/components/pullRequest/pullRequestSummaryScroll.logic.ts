const STICKY_EDGE_TOLERANCE_PX = 1;

/**
 * Returns the scroll offset that puts a section's natural top where its sticky heading is now.
 * Collapsing removes the body below that heading; without this adjustment, the unchanged numeric
 * offset points into the next section and makes its sticky heading appear to replace the one the
 * reader pressed.
 */
export function sectionCollapseAnchorScrollTop(input: {
  readonly scrollTop: number;
  readonly viewportTop: number;
  readonly sectionTop: number;
  readonly headingTop: number;
}): number | null {
  const sectionHasScrolledPastViewport = input.sectionTop < input.viewportTop;
  const headingIsPinned = input.headingTop <= input.viewportTop + STICKY_EDGE_TOLERANCE_PX;
  if (!sectionHasScrolledPastViewport || !headingIsPinned) return null;

  return Math.max(0, input.scrollTop + input.sectionTop - input.viewportTop);
}

/**
 * Whether scrolling should condense the detail header. Collapsing the fold grows the scroller, so
 * a short tab can lose most of its range. Condense only when more than a fold's height remains;
 * otherwise the refund lands at the top and the reopen check starts a collapse/reopen loop.
 */
export function shouldCondenseDetailChrome(input: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly foldHeight: number;
  readonly chromeDelta: number;
}): boolean {
  return (
    input.foldHeight > 0 &&
    input.scrollTop > input.foldHeight + 32 &&
    input.scrollHeight - input.clientHeight - input.chromeDelta > input.foldHeight
  );
}
