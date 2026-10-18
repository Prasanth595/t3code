import { expect, it } from "vite-plus/test";

import { OBTAINIUM_ADD_URL } from "./obtainium.ts";

const APP_PREFIX = "obtainium://app/";

it("decodes to the fork repository and its release settings, as the redirect page reads it", () => {
  // The same steps as src/pages/redirect.astro of the Obtainium apps site.
  const redirect = new URL(OBTAINIUM_ADD_URL).searchParams.get("r") ?? "";
  expect(redirect.startsWith(APP_PREFIX)).toBe(true);
  const app = JSON.parse(decodeURIComponent(redirect.slice(APP_PREFIX.length)));
  expect(app.url).toBe("https://github.com/Yarden-zamir/t3code");
  const settings = JSON.parse(app.additionalSettings);
  expect(settings).toMatchObject({ includePrereleases: true, fallbackToOlderReleases: true });

  const apkFilter = new RegExp(settings.apkFilterRegEx);
  expect(apkFilter.test("t3code-0.1.1-nightly.20261018.1440000-android.apk")).toBe(true);
  expect(apkFilter.test("T3-Code-0.1.1-nightly.20261018.1440000-arm64.dmg")).toBe(false);
  expect(apkFilter.test("t3code-0.1.1-android.apk.sha256")).toBe(false);
});
