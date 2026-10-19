import { expect, it } from "vite-plus/test";

import { inviteAppUrl, isPhone, passkeyReturnUrl } from "./clientInvite.ts";

it("hands the full fragment invite to the fork app's Add environment screen", () => {
  const invite = "https://portal.example.com/enroll/client#code=0123456789abcdef";
  const app = new URL(inviteAppUrl(invite));
  expect(app.protocol).toBe("t3code-preview:");
  expect(`${app.host}${app.pathname}`).toBe("connections/new");
  expect(app.searchParams.get("inviteUrl")).toBe(invite);
});

it.each(["Android", "iPhone", "iPad", "Mobile"])("offers app handoff on %s", (ua) => {
  expect(isPhone(ua)).toBe(true);
});

it("does not offer a phone app handoff on a desktop", () => {
  expect(isPhone("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
});

it("resumes only an invite on the same portal after the passkey step", () => {
  const start = "https://portal.example.com/api/grant/start";
  expect(passkeyReturnUrl(new URL(`${start}?resume=invite&then=%23%2Fmap`))).toBe(
    "https://portal.example.com/?resume=invite#/map",
  );
  expect(passkeyReturnUrl(new URL(`${start}?then=%23%2Fclients`))).toBe(
    "https://portal.example.com/#/clients",
  );
  expect(passkeyReturnUrl(new URL(`${start}?resume=other&then=https://evil.example`))).toBe(
    "https://portal.example.com/",
  );
});
