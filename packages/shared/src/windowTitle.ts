const SEPARATOR = " · ";

/** `Thread · Project · App`, skipping empty parts. */
export function formatWindowTitle(input: {
  readonly appName: string;
  readonly context: ReadonlyArray<string | null | undefined>;
}): string {
  const context = input.context.map((part) => part?.trim()).filter(Boolean);
  return [...context, input.appName].join(SEPARATOR);
}

/**
 * The desktop shell owns the app name: before the web app mounts, the page
 * title is the static HTML one. Keep only the context the page put in front.
 */
export function resolveDesktopWindowTitle(pageTitle: string, appName: string): string {
  const end = pageTitle.lastIndexOf(SEPARATOR);
  return end === -1 ? appName : `${pageTitle.slice(0, end)}${SEPARATOR}${appName}`;
}
