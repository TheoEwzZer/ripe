/** What the person asks of the recipes. Shared by the UI, Convex and the recording script. */

export const timeLimits = [10, 15, 30] as const;
export const equipmentModes = ["microwave", "air-fryer", "one-pan"] as const;
export const diets = ["vegetarian", "vegan", "gluten-free"] as const;

export type TimeLimit = (typeof timeLimits)[number];
export type EquipmentMode = (typeof equipmentModes)[number];
export type Diet = (typeof diets)[number];

export type CookFilters = {
  /** Each recipe must use at least two of the five most urgent items. */
  emergency: boolean;
  maxMinutes?: TimeLimit;
  equipment?: EquipmentMode;
  diet: Diet[];
  /** Two pots, pans or trays at most. */
  fewDishes: boolean;
  servings: number;
  /** Dinners for the coming evenings, from tonight, arranged by Ripe so nothing goes off first. */
  plan?: boolean;
  /** How many recipes, or how many days in a plan; unset means 3. */
  count?: number;
};

export const DEFAULT_COUNT = 3;
export const MIN_COUNT = 1;
export const MAX_COUNT = 6;
/** A plan needs two evenings to arrange anything, and Muse Wonder plans well up to five. */
export const MIN_PLAN_DAYS = 2;
export const MAX_PLAN_DAYS = 5;

/** The number asked for, kept inside what the current mode allows. */
export function countOf(f: Pick<CookFilters, "plan" | "count">): number {
  const n = Math.round(f.count ?? DEFAULT_COUNT);
  return f.plan ? Math.max(MIN_PLAN_DAYS, Math.min(MAX_PLAN_DAYS, n)) : Math.max(MIN_COUNT, Math.min(MAX_COUNT, n));
}

export const MIN_SERVINGS = 1;
export const MAX_SERVINGS = 8;

export const defaultFilters: CookFilters = { emergency: false, diet: [], fewDishes: false, servings: 2 };

/** One canonical string per filter set: recordings are looked up by it. */
export function filtersKey(f: CookFilters): string {
  return [
    f.emergency ? "urgent" : "",
    f.maxMinutes ? `${f.maxMinutes}min` : "",
    f.equipment ?? "",
    ...[...f.diet].sort(),
    f.fewDishes ? "few-dishes" : "",
    `${f.servings}p`,
    f.plan ? "plan" : "",
    // Three is the default: recordings made before the count existed keep their key.
    countOf(f) === DEFAULT_COUNT ? "" : `${countOf(f)}x`,
  ]
    .filter(Boolean)
    .join("+");
}

export function sameFilters(a: CookFilters, b: CookFilters): boolean {
  return filtersKey(a) === filtersKey(b);
}
