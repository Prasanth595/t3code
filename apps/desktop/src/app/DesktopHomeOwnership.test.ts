import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as DesktopHomeOwnership from "./DesktopHomeOwnership.ts";
import type { DesktopWindowError } from "../window/DesktopWindow.ts";

const healthyOwner: DesktopHomeOwnership.DesktopHomeOwner = {
  _tag: "healthy",
  record: {
    version: 1,
    pid: 4242,
    port: 3773,
    origin: "http://127.0.0.1:3773",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  ownedByThisDesktop: true,
};

const foreignOwner: DesktopHomeOwnership.DesktopHomeOwner = {
  _tag: "foreign",
  record: {
    version: 1,
    pid: 4243,
    port: 3774,
    origin: "http://127.0.0.1:3774",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
};

interface ReportResult {
  readonly dialogs: ReadonlyArray<readonly [string, string]>;
  readonly windowsOpened: number;
}

const report = (
  owner: DesktopHomeOwnership.DesktopHomeOwner,
  options?: { readonly quitting?: boolean },
): Effect.Effect<ReportResult, DesktopWindowError> =>
  Effect.gen(function* () {
    const dialogs: Array<readonly [string, string]> = [];
    const windows = yield* Ref.make(0);
    yield* DesktopHomeOwnership.reportHomeOwnedByAnotherServer({
      owner,
      showErrorBox: (title, content) =>
        Effect.sync(() => {
          dialogs.push([title, content]);
        }),
      openMainWindow: Ref.updateAndGet(windows, (count) => count + 1),
      isQuitting: Effect.succeed(options?.quitting ?? false),
    });
    return { dialogs, windowsOpened: yield* Ref.get(windows) };
  });

describe("DesktopHomeOwnership", () => {
  it.effect("keeps the app open when another server owns the T3 home", () =>
    Effect.gen(function* () {
      const result = yield* report(healthyOwner);

      assert.equal(result.windowsOpened, 1, "the window must open so Settings stays reachable");
      assert.equal(result.dialogs.length, 1, "the owner must be reported");
      assert.equal(result.dialogs[0]?.[0], "This T3 home is already in use");
      assert.include(
        result.dialogs[0]?.[1] ?? "",
        "http://127.0.0.1:3773",
        "the dialog must name the server that owns the home",
      );
    }),
  );

  it.effect("keeps the app open when the owner does not answer", () =>
    Effect.gen(function* () {
      const result = yield* report(foreignOwner);

      assert.equal(result.windowsOpened, 1);
      assert.include(result.dialogs[0]?.[1] ?? "", "is not responding");
    }),
  );

  it.effect("does not open a window while the app is quitting", () =>
    Effect.gen(function* () {
      const result = yield* report(healthyOwner, { quitting: true });

      assert.equal(result.windowsOpened, 0, "a quitting app must not open a window");
      assert.equal(result.dialogs.length, 1, "the owner must still be reported");
    }),
  );
});
