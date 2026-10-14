import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { chromium } from "playwright-core";

import * as PreviewBrowser from "./PreviewBrowser.ts";

const FRAME_WINDOW = 6;
const browserLayer = Layer.effect(
  PreviewBrowser.PreviewBrowser,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const workingDirectory = yield* HostProcess.WorkingDirectory;
    return yield* PreviewBrowser.makePreviewBrowser({
      baseDir: path.join(workingDirectory, ".t3", "screencast-test"),
      wait: "2 minutes",
    });
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)));

interface AnimatedPageGlobals {
  readonly document: {
    readonly documentElement: { readonly dataset: Record<string, string | undefined> };
  };
  readonly requestAnimationFrame: (callback: () => void) => number;
}

it.live("holds six screencast frames until acknowledgements reach pinned Chrome", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
      const executablePath = yield* previewBrowser.executable;
      const platform = yield* HostProcess.Platform;
      const architecture = yield* HostProcess.Architecture;
      const release = PreviewBrowser.previewBrowserRelease(platform, architecture);
      expect(release).not.toBeNull();

      const browser = yield* Effect.acquireRelease(
        Effect.promise(() =>
          chromium.launch({
            executablePath,
            headless: true,
            args: [
              "--disable-gpu",
              "--force-device-scale-factor=2",
              "--disable-blink-features=AutomationControlled",
            ],
            ignoreDefaultArgs: ["--enable-automation"],
          }),
        ),
        (value) => Effect.promise(() => value.close()),
      );
      const context = yield* Effect.acquireRelease(
        Effect.promise(() => browser.newContext({ viewport: { width: 640, height: 400 } })),
        (value) => Effect.promise(() => value.close()),
      );
      const page = yield* Effect.promise(() => context.newPage());
      const cdp = yield* Effect.acquireRelease(
        Effect.promise(() => context.newCDPSession(page)),
        (value) =>
          Effect.promise(async () => {
            await value.send("Page.stopScreencast").catch(() => {});
            await value.detach().catch(() => {});
          }),
      );

      const version = yield* Effect.promise(() => cdp.send("Browser.getVersion"));
      expect(version.product).toContain(`Chrome/${release!.version}`);

      yield* Effect.promise(() =>
        page.setContent(`
            <canvas width="640" height="400"></canvas>
            <script>
              const canvas = document.querySelector('canvas');
              const context = canvas.getContext('2d');
              let paintCount = 0;
              function paint() {
                context.fillStyle = 'hsl(' + (paintCount++ % 360) + ' 80% 50%)';
                context.fillRect(0, 0, canvas.width, canvas.height);
                document.documentElement.dataset.paintCount = String(paintCount);
                requestAnimationFrame(paint);
              }
              requestAnimationFrame(paint);
            </script>
          `),
      );

      const frames: Array<{ readonly sessionId: number }> = [];
      const waiters = new Set<() => void>();
      cdp.on("Page.screencastFrame", (frame) => {
        frames.push(frame);
        for (const wake of waiters) wake();
      });
      const waitForFrames = (count: number) =>
        Effect.gen(function* () {
          if (frames.length >= count) return;
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                const wake = () => {
                  if (frames.length < count) return;
                  waiters.delete(wake);
                  resolve();
                };
                waiters.add(wake);
              }),
          );
        }).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.die(
                new Error(
                  `Timed out waiting for screencast frame ${count}; received ${frames.length}`,
                ),
              ),
          }),
        );
      const waitForPaints = (target: number) =>
        Effect.promise(() =>
          page.evaluate((paintCount) => {
            const browserWindow = globalThis as unknown as AnimatedPageGlobals;
            return new Promise<void>((resolve) => {
              const wait = () => {
                if (
                  Number(browserWindow.document.documentElement.dataset.paintCount ?? 0) >=
                  paintCount
                ) {
                  resolve();
                } else {
                  browserWindow.requestAnimationFrame(wait);
                }
              };
              wait();
            });
          }, target),
        );

      const readPaintCount = () =>
        Effect.promise(() =>
          page.evaluate(() => {
            const browserWindow = globalThis as unknown as AnimatedPageGlobals;
            return Number(browserWindow.document.documentElement.dataset.paintCount ?? 0);
          }),
        );
      const screencastParams = {
        format: "jpeg",
        quality: 70,
        maxWidth: 640,
        maxHeight: 400,
        maxFramesInFlight: FRAME_WINDOW,
      } as const;
      yield* Effect.promise(() => cdp.send("Page.startScreencast", screencastParams));
      yield* waitForFrames(FRAME_WINDOW);
      const paintsBeforeHold = yield* readPaintCount();
      yield* waitForPaints(paintsBeforeHold + 30);
      expect(frames).toHaveLength(FRAME_WINDOW);

      for (let expected = FRAME_WINDOW + 1; expected <= FRAME_WINDOW + 3; expected += 1) {
        const frame = frames[expected - FRAME_WINDOW - 1]!;
        yield* Effect.promise(() =>
          cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }),
        );
        yield* waitForFrames(expected);
      }
      expect(frames).toHaveLength(FRAME_WINDOW + 3);
    }),
  ).pipe(Effect.provide(browserLayer)),
);
