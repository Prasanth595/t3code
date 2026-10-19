/**
 * Fork: the Android icons of the fork APK, the Tick3d lightning icon
 * (`assets/fork/tick3d-android-*.svg`). `app.config.ts` applies them when `T3CODE_ANDROID_PACKAGE`
 * is set, which only `scripts/fork-android-apk.sh` does. iOS keeps the variant icon.
 */
const FORK_ANDROID_ICON_ASSETS = {
  androidAdaptiveForeground: "./assets/fork/android-icon-foreground.png",
  androidAdaptiveBackgroundColor: "#E4E7FF",
  androidAdaptiveBackgroundImage: "./assets/fork/android-icon-background.png",
  androidSplashIcon: "./assets/fork/android-splash-icon.png",
  androidMonochromeIcon: "./assets/fork/android-icon-monochrome.png",
  androidNotificationIcon: "./assets/fork/android-notification-icon.png",
  androidNotificationColor: "#6C5CE7",
} as const;

export function withForkAndroidIcon<Variant extends { readonly assets: object }>(
  variant: Variant,
): Variant {
  return { ...variant, assets: { ...variant.assets, ...FORK_ANDROID_ICON_ASSETS } };
}
