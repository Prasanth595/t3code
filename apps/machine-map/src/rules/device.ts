/** A short device and browser name from a User-Agent header, for history (MM-702) and Devices (MM-901). */
export function describeUserAgent(userAgent: string | null): { device: string; browser: string } {
  const ua = userAgent ?? "";
  const device = ua.includes("iPhone")
    ? "iPhone"
    : ua.includes("iPad")
      ? "iPad"
      : ua.includes("Android")
        ? "Android"
        : ua.includes("Macintosh") || ua.includes("Mac OS X")
          ? "Mac"
          : ua.includes("Windows")
            ? "Windows"
            : ua.includes("Linux")
              ? "Linux"
              : "Unknown device";
  // Order matters: Edge and Chrome also say "Safari", and Edge also says "Chrome".
  const browser = ua.includes("Edg/")
    ? "Edge"
    : ua.includes("Firefox/") || ua.includes("FxiOS/")
      ? "Firefox"
      : ua.includes("Chrome/") || ua.includes("CriOS/")
        ? "Chrome"
        : ua.includes("Safari/")
          ? "Safari"
          : "Unknown browser";
  return { device, browser };
}
