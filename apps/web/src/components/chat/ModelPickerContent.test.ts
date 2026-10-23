import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { initialModelPickerProvider } from "./ModelPickerContent";

describe("initialModelPickerProvider", () => {
  const activeInstanceId = ProviderInstanceId.make("claudeAgent_personal");
  const input = {
    activeInstanceId,
    keepActiveInstance: false,
    activeInstanceVisible: true,
    hasFavorites: true,
    lastOrigin: null,
  } as const;

  it("reopens on the tab the last model was picked from", () => {
    expect(initialModelPickerProvider({ ...input, lastOrigin: "favorites" })).toBe("favorites");
    expect(initialModelPickerProvider({ ...input, lastOrigin: "instance" })).toBe(activeInstanceId);
    expect(initialModelPickerProvider(input)).toBe(activeInstanceId);
  });

  it("keeps the active instance when it is locked, needs setup, or there are no favorites", () => {
    expect(
      initialModelPickerProvider({ ...input, keepActiveInstance: true, lastOrigin: "favorites" }),
    ).toBe(activeInstanceId);
    expect(
      initialModelPickerProvider({ ...input, hasFavorites: false, lastOrigin: "favorites" }),
    ).toBe(activeInstanceId);
  });

  it("falls back to favorites when the active instance is not in the rail", () => {
    expect(
      initialModelPickerProvider({
        ...input,
        activeInstanceVisible: false,
        lastOrigin: "instance",
      }),
    ).toBe("favorites");
  });
});
