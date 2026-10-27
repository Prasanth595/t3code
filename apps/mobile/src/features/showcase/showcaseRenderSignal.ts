import type { MobileThemeId } from "../../lib/mobileTheme";
import type { ShowcaseScene } from "./nativeShowcaseScene";

export type ShowcaseRenderSignal = Readonly<{
  scene: ShowcaseScene;
  themeId: MobileThemeId;
}>;

const listeners = new Set<() => void>();
let renderSignal: ShowcaseRenderSignal | null = null;
// A redraw can repeat the same scene and theme; counting reports lets it restart the settle delay.
let renderReports = 0;

export function getShowcaseRenderSignal(): ShowcaseRenderSignal | null {
  return renderSignal;
}

export function getShowcaseRenderReports(): number {
  return renderReports;
}

export function subscribeToShowcaseRenderSignal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportShowcaseSceneRendered(signal: ShowcaseRenderSignal): void {
  renderSignal = signal;
  renderReports += 1;
  for (const listener of listeners) listener();
}

export function clearShowcaseRenderSignal(): void {
  if (renderSignal === null) return;
  renderSignal = null;
  renderReports += 1;
  for (const listener of listeners) listener();
}

export function isShowcaseNativeContentReady(input: {
  readonly scene: ShowcaseScene;
  readonly themeId: MobileThemeId;
  readonly renderSignal: ShowcaseRenderSignal | null;
}): boolean {
  if (input.scene !== "review") return true;
  return input.renderSignal?.scene === "review" && input.renderSignal.themeId === input.themeId;
}
