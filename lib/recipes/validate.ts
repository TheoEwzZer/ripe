import { mostUrgent, urgencyWeight } from "../pantry/freshness";
import type { CookFilters, Diet, EquipmentMode } from "./filters";
import { stapleById } from "./pantry";
import type { CookedRecipe } from "./schema";

/**
 * Ripe checks every recipe Muse Wonder writes against the kitchen and the
 * filters, and computes the anti-waste score itself: the model never grades
 * its own homework.
 */

export type KitchenItem = { id: string; name: string; quantity: string; daysLeft: number; category: string };

export type MatchedUse = { ingredient: string; amount: string; share: number; item: KitchenItem | null };

export type Issue =
  | { code: "unknown"; ingredient: string }
  | { code: "staple"; staple: string }
  | { code: "toBuy"; count: number }
  | { code: "time"; minutes: number; limit: number }
  | { code: "equipment"; mode: EquipmentMode }
  | { code: "dishes"; dishes: number; limit: number }
  | { code: "diet"; diet: Diet; ingredient: string }
  | { code: "urgent"; used: number }
  | { code: "empty" }
  /** Plan only: the item goes off before the day its recipe is planned. */
  | { code: "late"; ingredient: string; day: number; daysLeft: number }
  /** Plan only: the planned recipes together use more of the item than there is. */
  | { code: "overused"; ingredient: string; share: number };

export const MAX_TO_BUY = 2;
/** 100 means the recipe finishes the four items closest to being wasted. */
export const SCORE_TOP_N = 4;

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
const singular = (s: string) => fold(s).replace(/(es|s)$/, "");

/** Exact name first, then plurals, then one name inside the other ("baby carrot" for "carrot"). The most urgent wins. */
export function matchIngredient(name: string, kitchen: readonly KitchenItem[]): KitchenItem | null {
  const urgentFirst = [...kitchen].sort((a, b) => a.daysLeft - b.daysLeft);
  const wanted = fold(name);
  if (!wanted) return null;
  return (
    urgentFirst.find((i) => fold(i.name) === wanted) ??
    urgentFirst.find((i) => singular(i.name) === singular(wanted)) ??
    urgentFirst.find((i) => {
      const have = singular(i.name);
      return have.length > 2 && (singular(wanted).includes(have) || have.includes(singular(wanted)));
    }) ??
    null
  );
}

const MEAT = /\b(chicken|beef|pork|bacon|ham|sausage|lamb|turkey|chorizo|prosciutto|salami|anchov|tuna|salmon|shrimp|prawn|fish|poulet|boeuf|porc|lardon|jambon|saucisse|agneau|dinde|thon|saumon|crevette|poisson)/;
const ANIMAL = /\b(milk|cheese|butter|cream|yogh?urt|parmesan|egg|honey|lait|fromage|beurre|creme|yaourt|oeuf|miel)/;
const GLUTEN = /\b(pasta|spaghetti|bread|flour|noodle|couscous|breadcrumb|tortilla|pastry|pate|pain|farine|nouille|chapelure|semoule)/;

function dietBreaker(diet: Diet, recipe: CookedRecipe, uses: MatchedUse[]): string | null {
  const meatCategories = new Set(["meat", "fish"]);
  const animalCategories = new Set(["meat", "fish", "dairy", "egg"]);
  for (const use of uses) {
    const category = use.item?.category ?? "";
    const name = fold(use.item?.name ?? use.ingredient);
    if (diet === "vegetarian" && (meatCategories.has(category) || MEAT.test(name))) return use.ingredient;
    if (diet === "vegan" && (animalCategories.has(category) || MEAT.test(name) || ANIMAL.test(name))) return use.ingredient;
    if (diet === "gluten-free" && (category === "bakery" || GLUTEN.test(name))) return use.ingredient;
  }
  for (const id of recipe.staples) {
    const tags = stapleById(id)?.tags ?? [];
    if (diet === "vegan" && tags.includes("animal")) return id;
    if (diet === "gluten-free" && tags.includes("gluten")) return id;
  }
  for (const item of recipe.toBuy) {
    const name = fold(item);
    if (diet === "vegetarian" && MEAT.test(name)) return item;
    if (diet === "vegan" && (MEAT.test(name) || ANIMAL.test(name))) return item;
    if (diet === "gluten-free" && GLUTEN.test(name)) return item;
  }
  return null;
}

/** Items at least as urgent as the fifth most urgent one: ties count. */
export function urgentIds(kitchen: readonly KitchenItem[]): Set<string> {
  const top = mostUrgent(kitchen, 5);
  const threshold = top.at(-1)?.daysLeft ?? -1;
  return new Set(kitchen.filter((i) => i.daysLeft <= threshold).map((i) => i.id));
}

export function checkRecipe(
  recipe: CookedRecipe,
  ctx: { kitchen: readonly KitchenItem[]; pantry: readonly string[]; filters: CookFilters },
): { uses: MatchedUse[]; issues: Issue[] } {
  const { kitchen, pantry, filters } = ctx;
  const uses: MatchedUse[] = recipe.uses.map((u) => ({
    ingredient: u.ingredient,
    amount: u.amount,
    share: Math.min(1, Math.max(0, Number.isFinite(u.share) ? u.share : 0.5)),
    item: matchIngredient(u.ingredient, kitchen),
  }));
  const issues: Issue[] = [];

  if (uses.length === 0) issues.push({ code: "empty" });
  for (const use of uses) if (!use.item) issues.push({ code: "unknown", ingredient: use.ingredient });
  const allowed = new Set(pantry);
  for (const id of recipe.staples) if (!allowed.has(id)) issues.push({ code: "staple", staple: id });
  if (recipe.toBuy.length > MAX_TO_BUY) issues.push({ code: "toBuy", count: recipe.toBuy.length });
  if (filters.maxMinutes && recipe.minutes > filters.maxMinutes) {
    issues.push({ code: "time", minutes: recipe.minutes, limit: filters.maxMinutes });
  }

  const equipment = new Set(recipe.equipment);
  if (filters.equipment === "microwave" && [...equipment].some((e) => e !== "microwave")) issues.push({ code: "equipment", mode: "microwave" });
  if (filters.equipment === "air-fryer" && [...equipment].some((e) => e !== "air-fryer")) issues.push({ code: "equipment", mode: "air-fryer" });
  if (filters.equipment === "one-pan" && (equipment.has("oven") || recipe.dishes > 1)) issues.push({ code: "equipment", mode: "one-pan" });
  if (filters.fewDishes && recipe.dishes > 2) issues.push({ code: "dishes", dishes: recipe.dishes, limit: 2 });

  for (const diet of filters.diet) {
    const breaker = dietBreaker(diet, recipe, uses);
    if (breaker) issues.push({ code: "diet", diet, ingredient: breaker });
  }

  if (filters.emergency && kitchen.length >= 2) {
    const urgent = urgentIds(kitchen);
    const used = new Set(uses.flatMap((u) => (u.item && urgent.has(u.item.id) ? [u.item.id] : []))).size;
    if (used < 2) issues.push({ code: "urgent", used });
  }
  return { uses, issues };
}

/**
 * The urgency weight of each item used, times the share of it the recipe
 * uses, over what finishing the four most urgent items would score.
 */
export function antiWasteScore(uses: readonly MatchedUse[], kitchen: readonly KitchenItem[]): number {
  const shares = new Map<string, { item: KitchenItem; share: number }>();
  for (const use of uses) {
    if (!use.item) continue;
    const seen = shares.get(use.item.id);
    shares.set(use.item.id, { item: use.item, share: Math.min(1, (seen?.share ?? 0) + use.share) });
  }
  const rescued = [...shares.values()].reduce((sum, { item, share }) => sum + urgencyWeight(item.daysLeft) * share, 0);
  const best = mostUrgent(kitchen, SCORE_TOP_N).reduce((sum, i) => sum + urgencyWeight(i.daysLeft), 0);
  return best > 0 ? Math.round(100 * Math.min(1, rescued / best)) : 0;
}

/** Plain English for the correction prompt. */
export function issueText(issue: Issue): string {
  switch (issue.code) {
    case "unknown":
      return `"${issue.ingredient}" is not in my kitchen: use only my items, or move it to toBuy`;
    case "staple":
      return `"${issue.staple}" is not in my pantry list`;
    case "toBuy":
      return `${issue.count} items to buy, the limit is ${MAX_TO_BUY}`;
    case "time":
      return `takes ${issue.minutes} minutes, the limit is ${issue.limit}`;
    case "equipment":
      return issue.mode === "one-pan"
        ? "must cook in a single pan on the hob, no oven"
        : `must use only the ${issue.mode === "microwave" ? "microwave" : "air fryer"}`;
    case "dishes":
      return `uses ${issue.dishes} pots or pans, the limit is ${issue.limit}`;
    case "diet":
      return `"${issue.ingredient}" breaks the ${issue.diet} diet`;
    case "urgent":
      return `uses ${issue.used} of my most urgent items, it must use at least 2`;
    case "late":
      return `"${issue.ingredient}" is planned on day ${issue.day + 1} but only keeps ${issue.daysLeft} days`;
    case "overused":
      return `the plan uses ${Math.round(issue.share * 100)}% of "${issue.ingredient}"`;
    case "empty":
      return "uses nothing from my kitchen";
  }
}
