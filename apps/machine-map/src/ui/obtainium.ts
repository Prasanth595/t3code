/**
 * The fork Android app in Obtainium, with the release settings of docs/fork.md "Android app".
 * Fork releases are prereleases, and most have no APK, so Obtainium falls back to older ones.
 */
const FORK_ANDROID_APP = {
  id: "com.yardenzamir.t3code",
  url: "https://github.com/Yarden-zamir/t3code",
  author: "Yarden-zamir",
  name: "T3 Code fork",
  // Obtainium reads `additionalSettings` as a JSON string, not as an object.
  additionalSettings: JSON.stringify({
    includePrereleases: true,
    fallbackToOlderReleases: true,
    apkFilterRegEx: "android\\.apk$",
  }),
};

/**
 * Obtainium's redirect page opens `obtainium://app/<json>` in the app, and offers Obtainium when
 * the phone does not have it. The form comes from BADGING.md of ImranR98/apps.obtainium.imranr.dev.
 */
export const OBTAINIUM_ADD_URL = `https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/${encodeURIComponent(JSON.stringify(FORK_ANDROID_APP))}`;
