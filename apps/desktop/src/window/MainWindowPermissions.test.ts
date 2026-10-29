import { describe, expect, it } from "vite-plus/test";

import { allowsMainWindowPermission } from "./MainWindowPermissions.ts";

const applicationUrl = "t3code://app/";

describe("allowsMainWindowPermission", () => {
  it.each([
    { requestingUrl: "t3code://app/threads/1", mediaTypes: ["audio"], allowed: true },
    { requestingUrl: "t3code://app/", mediaTypes: ["audio", "video"], allowed: false },
    { requestingUrl: "t3code://app/", mediaTypes: ["video"], allowed: false },
    { requestingUrl: "t3code://app/", mediaTypes: [], allowed: false },
    { requestingUrl: "t3code-dev://app/", mediaTypes: ["audio"], allowed: false },
    { requestingUrl: "t3code://other/", mediaTypes: ["audio"], allowed: false },
    { requestingUrl: "https://example.com/", mediaTypes: ["audio"], allowed: false },
    { requestingUrl: "blob:t3code://app/1234", mediaTypes: ["audio"], allowed: false },
  ])(
    "lets only the app page record audio: $requestingUrl $mediaTypes",
    ({ requestingUrl, mediaTypes, allowed }) => {
      expect(
        allowsMainWindowPermission({
          permission: "media",
          requestingUrl,
          mediaTypes,
          applicationUrl,
        }),
      ).toBe(allowed);
    },
  );

  it("keeps Electron's default grant for other permissions", () => {
    expect(
      allowsMainWindowPermission({
        permission: "notifications",
        requestingUrl: "https://example.com/",
        mediaTypes: undefined,
        applicationUrl,
      }),
    ).toBe(true);
  });
});
