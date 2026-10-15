import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CLOUDFLARE_ACCESS_PAIRING_PATH,
  missingSiblingOrigins,
  requestSiblingPairingCredential,
} from "./siblingEnvironments";

const page = { protocol: "https:", hostname: "t3-vps.example.com" };

describe("missingSiblingOrigins", () => {
  it("returns trusted siblings that no saved environment points at", () => {
    expect(
      missingSiblingOrigins({
        trustedOrigins: [
          "https://t3-mac.example.com",
          "https://t3-win.example.com",
          "https://t3.other.com",
        ],
        savedUrls: ["https://t3-mac.example.com/", null, "https://t3-vps.example.com"],
        page,
      }),
    ).toEqual(["https://t3-win.example.com"]);
  });

  it("adds nothing on a page that is not served over https", () => {
    expect(
      missingSiblingOrigins({
        trustedOrigins: ["https://t3-mac.example.com"],
        savedUrls: [],
        page: { protocol: "http:", hostname: "127.0.0.1" },
      }),
    ).toEqual([]);
  });
});

describe("requestSiblingPairingCredential", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts with cookies and returns the credential", async () => {
    const fetchMock = vi.fn(async () => Response.json({ credential: "PAIR123" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestSiblingPairingCredential("https://t3-mac.example.com")).resolves.toBe(
      "PAIR123",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://t3-mac.example.com${CLOUDFLARE_ACCESS_PAIRING_PATH}`,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("fails on a rejected request or a body without a credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(requestSiblingPairingCredential("https://t3-mac.example.com")).rejects.toThrow(
      "401",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    await expect(requestSiblingPairingCredential("https://t3-mac.example.com")).rejects.toThrow(
      "no pairing credential",
    );
  });
});
