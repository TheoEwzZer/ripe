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
};

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
  ]
    .filter(Boolean)
    .join("+");
}

export function sameFilters(a: CookFilters, b: CookFilters): boolean {
  return filtersKey(a) === filtersKey(b);
}
