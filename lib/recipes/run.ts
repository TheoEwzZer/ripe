import type { CookRequest, CookResult } from "../meta/cook";
import type { CookedRecipe } from "./schema";
import type { RecipeStreamHandlers } from "./stream";
import { antiWasteScore, checkRecipe, type Issue, type MatchedUse } from "./validate";

export type CheckedRecipe = {
  recipe: CookedRecipe;
  uses: MatchedUse[];
  issues: Issue[];
  score: number;
  /** Rewritten by the correction round. */
  fixed: boolean;
};

/** Where recipes come from: Muse Wonder live, or a recording replayed through the same reader. */
export type RecipeSource = {
  kind: "live" | "replay";
  cook: (req: CookRequest, handlers: RecipeStreamHandlers) => Promise<CookResult>;
  /** Absent when nothing can correct (a replay without a recorded fix). */
  fix?: (req: CookRequest, broken: { recipe: CookedRecipe; issues: Issue[] }[], handlers: RecipeStreamHandlers) => Promise<CookResult>;
};

export type CookingEvents = {
  draft?: (index: number, title: string) => Promise<void> | void;
  recipe?: (index: number, checked: CheckedRecipe) => Promise<void> | void;
  drop?: (index: number) => Promise<void> | void;
  fixing?: (indexes: number[]) => Promise<void> | void;
};

export type CookingSummary = {
  recipes: (CheckedRecipe | null)[];
  cook: CookResult;
  fix?: CookResult & { indexes: number[] };
};

export function check(recipe: CookedRecipe, req: CookRequest, fixed = false): CheckedRecipe {
  const { uses, issues } = checkRecipe(recipe, req);
  return { recipe, uses, issues, score: antiWasteScore(uses, req.kitchen), fixed };
}

/**
 * Cook → check each recipe as it lands → one correction round for the ones
 * that break a rule. A correction is kept only if it breaks fewer rules.
 */
export async function runCooking(source: RecipeSource, req: CookRequest, events: CookingEvents = {}): Promise<CookingSummary> {
  const recipes: (CheckedRecipe | null)[] = [];
  const cooked = await source.cook(req, {
    onTitle: (index, title) => events.draft?.(index, title),
    onRecipe: async (index, recipe) => {
      recipes[index] = check(recipe, req);
      await events.recipe?.(index, recipes[index]);
    },
    onDrop: async (index) => {
      recipes[index] = null;
      await events.drop?.(index);
    },
  });

  const indexes = recipes.flatMap((r, i) => (r && r.issues.length > 0 ? [i] : []));
  if (indexes.length === 0 || !source.fix) return { recipes, cook: cooked };

  await events.fixing?.(indexes);
  const broken = indexes.map((i) => ({ recipe: recipes[i]!.recipe, issues: recipes[i]!.issues }));
  const fixed = await source.fix(req, broken, {
    onRecipe: async (k, recipe) => {
      const index = indexes[k];
      if (index === undefined) return;
      const candidate = check(recipe, req, true);
      if (candidate.issues.length < recipes[index]!.issues.length) recipes[index] = candidate;
      await events.recipe?.(index, recipes[index]!);
    },
  });
  // Recipes the correction skipped keep their issues; say so to every screen.
  for (const index of indexes.slice(fixed.recipes.length)) await events.recipe?.(index, recipes[index]!);
  return { recipes, cook: cooked, fix: { ...fixed, indexes } };
}
