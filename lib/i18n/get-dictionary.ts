import "server-only";
import type { Locale } from "./config";
import type { Dictionary } from "./dictionaries/en";

const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
  en: () => import("./dictionaries/en").then((m) => m.en),
  fr: () => import("./dictionaries/fr").then((m) => m.fr),
};

/** Cached, so pages that read it stay instant on client navigation (Cache Components). */
export async function getDictionary(locale: Locale): Promise<Dictionary> {
  "use cache";
  return dictionaries[locale]();
}
