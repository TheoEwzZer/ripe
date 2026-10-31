/**
 * What saving an item is worth: its weight, its price and the greenhouse
 * gases of producing it, which are lost when it is thrown away.
 *
 * Carbon factors: ADEME, Agribalyse 3.2 (updated 15/01/2025), as published by
 * ADEME's Impact CO2 (impactco2.fr/outils/alimentation, data in
 * github.com/incubateur-ademe/impactco2, src/data/categories). Each value is
 * the sum of the life-cycle stages listed there, in kg CO2e per kg of food.
 * Category fallbacks are the mean of the listed items of that category.
 * Prices are Ripe's indicative French retail prices, not an official source.
 */

export type ItemLike = { name: string; quantity: string; category: string };

type Factor = { match: RegExp; co2e: number; unitKg: number; eurPerKg: number };

// Name patterns first (English names from Muse Spark, French names said aloud), most specific first.
const FOODS: Factor[] = [
  { match: /cherry tomato|tomate cerise/, co2e: 0.63, unitKg: 0.25, eurPerKg: 6 },
  { match: /tomato|tomate/, co2e: 0.63, unitKg: 0.12, eurPerKg: 3 },
  { match: /zucchini|courgette/, co2e: 0.5, unitKg: 0.25, eurPerKg: 2.5 },
  { match: /spinach|epinard/, co2e: 0.42, unitKg: 0.2, eurPerKg: 8 },
  { match: /broccoli|brocoli/, co2e: 0.95, unitKg: 0.4, eurPerKg: 3.5 },
  { match: /carrot|carotte/, co2e: 0.4, unitKg: 0.1, eurPerKg: 1.8 },
  { match: /eggplant|aubergine/, co2e: 0.47, unitKg: 0.3, eurPerKg: 3.5 },
  { match: /pepper|poivron/, co2e: 0.72, unitKg: 0.18, eurPerKg: 4 },
  { match: /lettuce|salad|laitue|salade/, co2e: 0.87, unitKg: 0.35, eurPerKg: 4 },
  { match: /apple|pomme/, co2e: 0.41, unitKg: 0.18, eurPerKg: 2.8 },
  { match: /grapefruit juice|orange juice|jus/, co2e: 0.68, unitKg: 1, eurPerKg: 2.5 },
  { match: /orange/, co2e: 0.68, unitKg: 0.2, eurPerKg: 2.5 },
  { match: /lemon|lime|citron/, co2e: 0.76, unitKg: 0.12, eurPerKg: 3.5 },
  { match: /banana|banane/, co2e: 0.91, unitKg: 0.15, eurPerKg: 2 },
  { match: /kiwi/, co2e: 1.0, unitKg: 0.08, eurPerKg: 5 },
  { match: /milk|lait/, co2e: 1.15, unitKg: 1, eurPerKg: 1.2 },
  { match: /yog(h)?urt|yaourt/, co2e: 1.89, unitKg: 0.125, eurPerKg: 3 },
  { match: /mozzarella|brie|camembert|feta|goat cheese|chevre|ricotta/, co2e: 5.14, unitKg: 0.125, eurPerKg: 12 },
  { match: /cheese|fromage|parmesan|cheddar|emmental|comte/, co2e: 6.28, unitKg: 0.2, eurPerKg: 15 },
  { match: /egg|oeuf|œuf/, co2e: 1.88, unitKg: 0.06, eurPerKg: 5 },
  { match: /beef|steak|boeuf|bœuf|hach/, co2e: 28.01, unitKg: 0.25, eurPerKg: 18 },
  { match: /chicken|poulet|turkey|dinde/, co2e: 4.56, unitKg: 0.15, eurPerKg: 12 },
  { match: /bacon|ham|pork|sausage|jambon|porc|saucisse|lardon|chorizo|salami/, co2e: 6.67, unitKg: 0.15, eurPerKg: 13 },
  { match: /salmon|saumon/, co2e: 5.56, unitKg: 0.15, eurPerKg: 25 },
  { match: /cod|cabillaud/, co2e: 12.09, unitKg: 0.15, eurPerKg: 22 },
  { match: /tuna|thon/, co2e: 4.98, unitKg: 0.15, eurPerKg: 15 },
  { match: /rice|riz/, co2e: 2.01, unitKg: 0.25, eurPerKg: 2.5 },
  { match: /pasta|spaghetti|penne|pate|nouille|noodle/, co2e: 1.98, unitKg: 0.25, eurPerKg: 2 },
  { match: /baguette|bread roll|bread|pain/, co2e: 0.78, unitKg: 0.25, eurPerKg: 4 },
  { match: /tortilla|wrap|pain de mie/, co2e: 1.56, unitKg: 0.05, eurPerKg: 5 },
];

const mean = (values: number[]) => Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

// Means of the listed items of each category.
const CATEGORY: Record<string, Omit<Factor, "match">> = {
  produce: { co2e: mean([0.63, 0.5, 0.42, 0.95, 0.4, 0.47, 0.72, 0.87]), unitKg: 0.2, eurPerKg: 3.5 },
  fruit: { co2e: mean([0.41, 0.68, 0.76, 0.91, 1.0]), unitKg: 0.15, eurPerKg: 3.5 },
  dairy: { co2e: mean([1.15, 1.89, 5.14, 6.28]), unitKg: 0.2, eurPerKg: 8 },
  egg: { co2e: 1.88, unitKg: 0.06, eurPerKg: 5 },
  meat: { co2e: mean([28.01, 6.67, 4.56]), unitKg: 0.2, eurPerKg: 14 },
  fish: { co2e: mean([5.56, 12.09, 4.98]), unitKg: 0.15, eurPerKg: 20 },
  bakery: { co2e: mean([0.78, 1.56]), unitKg: 0.25, eurPerKg: 4 },
  pantry: { co2e: mean([2.01, 1.98]), unitKg: 0.3, eurPerKg: 3 },
  // A cooked dish: the mean of everything listed, for want of a per-kilo figure.
  leftover: { co2e: 2.0, unitKg: 0.3, eurPerKg: 6 },
  condiment: { co2e: 1.5, unitKg: 0.2, eurPerKg: 8 },
  drink: { co2e: 1.0, unitKg: 1, eurPerKg: 2 },
  other: { co2e: 1.5, unitKg: 0.2, eurPerKg: 5 },
};

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function factorFor(item: Pick<ItemLike, "name" | "category">): Omit<Factor, "match"> {
  const name = fold(item.name);
  const food = FOODS.find((f) => f.match.test(name));
  return food ?? CATEGORY[item.category] ?? CATEGORY.other;
}

const WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  un: 1,
  une: 1,
  two: 2,
  deux: 2,
  three: 3,
  trois: 3,
  four: 4,
  quatre: 4,
  six: 6,
  half: 0.5,
  demi: 0.5,
  moitie: 0.5,
};

/** Kilos in an item, from its quantity ("2", "~300 g", "1 kg", "half a bag") or one typical unit. */
export function weightKg(item: ItemLike): number {
  const q = fold(item.quantity);
  const unit = factorFor(item).unitKg;
  const grams = /(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/.exec(q);
  if (grams) {
    const n = Number(grams[1].replace(",", "."));
    const kg = grams[2] === "kg" || grams[2] === "l" ? n : grams[2] === "cl" ? n / 100 : n / 1000;
    // "4 x 125 g" is four of them.
    const times = /(\d+)\s*x\s*\d/.exec(q);
    return Math.min(20, kg * (times ? Number(times[1]) : 1));
  }
  const count = /(\d+(?:[.,]\d+)?)/.exec(q);
  if (count) return Math.min(20, Number(count[1].replace(",", ".")) * unit);
  const word = Object.entries(WORDS).find(([w]) => new RegExp(`\\b${w}\\b`).test(q));
  return (word ? word[1] : 1) * unit;
}

export type Impact = { kg: number; eur: number; co2e: number };

export const noImpact: Impact = { kg: 0, eur: 0, co2e: 0 };

/** What saving `share` of an item is worth. */
export function impactOf(item: ItemLike, share = 1): Impact {
  const kg = weightKg(item) * Math.max(0, Math.min(1, share));
  const f = factorFor(item);
  return { kg, eur: kg * f.eurPerKg, co2e: kg * f.co2e };
}

export function addImpact(a: Impact, b: Impact): Impact {
  return { kg: a.kg + b.kg, eur: a.eur + b.eur, co2e: a.co2e + b.co2e };
}

/** France, 2023: edible food wasted per person and year, all stages (ecologie.gouv.fr, gaspillage alimentaire). */
export const NATIONAL_WASTE_KG_PER_PERSON = 55;
