const VULGAR: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
const NUMBER = /(\d+(?:[.,]\d+)?)?\s?(\d+\/\d+|[¼½¾⅓⅔])|\d+(?:[.,]\d+)?/g;

function fractionValue(fraction: string): number {
  if (fraction in VULGAR) return VULGAR[fraction];
  const [top, bottom] = fraction.split("/").map(Number);
  return bottom ? top / bottom : NaN;
}

const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 4) / 4);

function format(n: number, locale: "en" | "fr"): string {
  const text = String(n);
  return locale === "fr" ? text.replace(".", ",") : text;
}

/** French nouns take the plural from 2; English from anything above 1 ("½ cup", "1.5 cups"). */
const isPlural = (n: number, locale: "en" | "fr") => (locale === "fr" ? n >= 2 : n > 1);

// The words after a number that agree with it stop at a preposition, punctuation or a unit.
const STOP = {
  fr: /^(de|du|des|à|au|aux|en|pour|et|ou|avec|sans|par|sur|environ|soit)$|^[dl]['’]/i,
  en: /^(of|for|to|in|and|or|with|without|per|about|plus)$/i,
};
const UNIT = /^(g|kg|mg|ml|cl|dl|l|oz|lb|lbs|tbsp|tsp|tbs|cs|cc|x)$|\.$/i;
const FR_INVARIABLE = /^(radis|pois|jus|anchois|ananas|maïs|cassis|frais|gros|gras|épais|mauvais|bas|riz|noix)$/i;
// In English only the measure or the noun changes: "1 large onion" → "2 large onions".
const EN_MEASURE =
  /^(box|boxes|head|heads|cup|cups|clove|cloves|can|cans|slice|slices|bunch|bunches|handful|handfuls|pinch|pinches|piece|pieces|stalk|stalks|sprig|sprigs|tin|tins|jar|jars|bag|bags|pack|packs|packet|packets|tablespoon|tablespoons|teaspoon|teaspoons|ball|balls|block|blocks|wedge|wedges|fillet|fillets|knob|knobs|drizzle|drizzles|splash|splashes|tub|tubs|punnet|punnets|bottle|bottles|stick|sticks|glass|glasses|bowl|bowls)$/i;

function frPlural(word: string): string {
  if (/[sxz]$/i.test(word)) return word;
  if (/^chou$/i.test(word) || /(eau|au|eu)$/i.test(word)) return `${word}x`;
  return `${word}s`;
}

function frSingular(word: string): string {
  if (FR_INVARIABLE.test(word)) return word;
  if (/^choux$/i.test(word) || /eaux$/i.test(word)) return word.slice(0, -1);
  return /s$/i.test(word) ? word.slice(0, -1) : word;
}

function enPlural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word) || /(tomato|potato|mango)$/i.test(word)) return `${word}es`;
  if (/(lea|hal|loa)f$/i.test(word)) return `${word.slice(0, -1)}ves`;
  return `${word}s`;
}

function enSingular(word: string): string {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(lea|hal|loa)ves$/i.test(word)) return `${word.slice(0, -3)}f`;
  if (/(sses|xes|zes|ches|shes|toes|goes)$/i.test(word)) return word.slice(0, -2);
  if (/(ss|us)$/i.test(word)) return word;
  return /s$/i.test(word) ? word.slice(0, -1) : word;
}

/** Makes the first words of `text` agree with the number just before it. */
function agree(text: string, plural: boolean, locale: "en" | "fr"): string {
  const lead = /^(\s*)((?:[\p{L}'’-]+\.?\s*){1,3})/u.exec(text);
  if (!lead) return text;
  const words: string[] = [];
  for (const word of lead[2].trim().split(/\s+/)) {
    if (STOP[locale].test(word) || UNIT.test(word)) break;
    words.push(word);
  }
  if (words.length === 0) return text;
  let targets = words.map((_, i) => i);
  if (locale === "en") {
    const measure = words.findIndex((w) => EN_MEASURE.test(w));
    targets = [measure >= 0 ? measure : words.length - 1];
  }
  const change = locale === "fr" ? (plural ? frPlural : frSingular) : plural ? enPlural : enSingular;
  const changed = words.map((w, i) => (targets.includes(i) ? change(w) : w));
  // Rebuild the phrase over the same spacing, then keep whatever followed it.
  let rest = text.slice(lead[1].length);
  let out = lead[1];
  words.forEach((word, i) => {
    const at = rest.indexOf(word);
    out += rest.slice(0, at) + changed[i];
    rest = rest.slice(at + word.length);
  });
  return out + rest;
}

/**
 * Scales the numbers in an amount for another number of servings, at $0:
 * "200 g" × 1.5 → "300 g", "1 1/2 cups" × 2 → "3 cups", "1 tête entière" × 2 → "2 têtes entières".
 */
export function scaleAmount(amount: string, factor: number, locale: "en" | "fr" = "en"): string {
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return amount;
  let out = "";
  let from = 0;
  let before: { was: number; now: number } | null = null;
  const words = (text: string) =>
    before && isPlural(before.was, locale) !== isPlural(before.now, locale) ? agree(text, isPlural(before.now, locale), locale) : text;
  for (const match of amount.matchAll(NUMBER)) {
    const [text, whole, fraction] = match;
    const value =
      fraction !== undefined ? (whole ? Number(whole.replace(",", ".")) : 0) + fractionValue(fraction) : Number(text.replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const scaled = round(value * factor);
    out += words(amount.slice(from, match.index)) + format(scaled, locale);
    before = { was: value, now: scaled };
    from = match.index + text.length;
  }
  return out + words(amount.slice(from));
}
