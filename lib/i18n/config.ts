export const locales = ["en", "fr"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/** Cookie set by the language toggle; the proxy prefers it over Accept-Language. */
export const LOCALE_COOKIE = "ripe-lang";
