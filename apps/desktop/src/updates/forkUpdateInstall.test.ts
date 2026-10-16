import { describe, expect, it } from "vite-plus/test";

import { resolveNewerUpdateVersion } from "./forkUpdateInstall.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const initial = createInitialDesktopUpdateState(
  "0.0.46-nightly.20261015.170000",
  { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
  "nightly",
);
const downloaded = "0.0.46-nightly.20261016.90000";
const checkFound = (version: string) =>
  reduceDesktopUpdateStateOnUpdateAvailable(initial, version, "2026-10-16T10:00:00.000Z");

describe("resolveNewerUpdateVersion", () => {
  it("asks only for a release newer than the download", () => {
    // Build numbers compare as numbers: 180000 is newer than 90000.
    expect(
      resolveNewerUpdateVersion(downloaded, checkFound("0.0.46-nightly.20261016.180000")),
    ).toBe("0.0.46-nightly.20261016.180000");
    expect(resolveNewerUpdateVersion(downloaded, checkFound(downloaded))).toBeNull();
    expect(
      resolveNewerUpdateVersion(downloaded, checkFound("0.0.46-nightly.20261015.990000")),
    ).toBeNull();
  });
});
