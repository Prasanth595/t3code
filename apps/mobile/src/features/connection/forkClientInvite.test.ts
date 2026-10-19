import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-device", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

import { forkClientInviteAddress } from "./forkClientInvite";

it("accepts an app invite for Address without accepting general pairing deep links", () => {
  const invite = "https://portal.example.com/enroll/client#code=0123456789abcdef";
  expect(forkClientInviteAddress(invite)).toBe(invite);
  expect(forkClientInviteAddress("https://server.example.com/#token=abc")).toBeNull();
  expect(forkClientInviteAddress("http://portal.example.com/enroll/client#code=abc")).toBeNull();
  expect(forkClientInviteAddress("https://portal.example.com/enroll/client")).toBeNull();
  expect(forkClientInviteAddress(undefined)).toBeNull();
});
