/**
 * Converts an NSLocale identifier such as `en_US@rg=nlzzzz` into a BCP 47 tag.
 * macOS stores a region override separate from the language (`rg`), and
 * Intl rejects the ICU `@` syntax, so the region is folded into the tag.
 */
export function toIntlLocale(icuLocale: string): string {
  const [base = "", keywords = ""] = icuLocale.split("@");
  const tag = base.replace(/_/g, "-");
  const regionOverride = keywords
    .split(";")
    .map((keyword) => /^rg=([a-z]{2}|\d{3})/i.exec(keyword)?.[1])
    .find((region) => region !== undefined);
  if (!regionOverride) return tag;

  try {
    return new Intl.Locale(tag, { region: regionOverride.toUpperCase() }).toString();
  } catch {
    return tag;
  }
}
