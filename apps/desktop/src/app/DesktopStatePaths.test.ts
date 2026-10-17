import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";

const joinPath = (first: string, ...segments: string[]) => [first, ...segments].join("/");

it("defaults the T3 home to ~/.t3code-factory", () => {
  assert.equal(
    resolveDesktopBaseDir({
      homeDirectory: "/Users/alice",
      joinPath,
      t3Home: Option.none(),
    }),
    "/Users/alice/.t3code-factory",
  );
});

it("treats a blank T3 home as unset", () => {
  assert.equal(
    resolveDesktopBaseDir({
      homeDirectory: "/Users/alice",
      joinPath,
      t3Home: Option.some("  "),
    }),
    "/Users/alice/.t3code-factory",
  );
});

it("lets an explicit T3 home win", () => {
  assert.equal(
    resolveDesktopBaseDir({
      homeDirectory: "/Users/alice",
      joinPath,
      t3Home: Option.some("/data/t3"),
    }),
    "/data/t3",
  );
});
