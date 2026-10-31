import { z } from "zod";

export const appliances = ["hob", "oven", "microwave", "air-fryer", "blender"] as const;
export const dietTags = ["vegetarian", "vegan", "gluten-free", "dairy-free"] as const;
export type Appliance = (typeof appliances)[number];

/**
 * What Muse Wonder must answer. Ingredient and staple names are enums built
 * from this kitchen, so the structured output can only name what is there;
 * anything else has to be declared in `toBuy`.
 */
export function recipeSchemaFor(inventoryNames: readonly string[], pantryIds: readonly string[], plan = false) {
  const ingredient = inventoryNames.length > 0 ? z.enum(inventoryNames as [string, ...string[]]) : z.string();
  const staple = pantryIds.length > 0 ? z.enum(pantryIds as [string, ...string[]]) : z.string();
  return z.object({
    title: z.string(),
    pitch: z.string().describe("One sentence on what this dish rescues"),
    minutes: z.number().int().min(1).max(240).describe("Prep and cooking time"),
    servings: z.number().int().min(1).max(12),
    equipment: z.array(z.enum(appliances)).describe("Appliances used"),
    dishes: z.number().int().min(0).max(10).describe("Pots, pans, trays and baking dishes used"),
    diet: z.array(z.enum(dietTags)),
    uses: z
      .array(
        z.object({
          ingredient: ingredient.describe("Exact name from my kitchen"),
          amount: z.string(),
          share: z.number().min(0).max(1).describe("Fraction of what I have that the recipe uses"),
        }),
      )
      .describe("Items from my kitchen this recipe uses"),
    staples: z.array(staple).describe("Pantry staples used, from my pantry list only"),
    toBuy: z.array(z.string()).describe("Missing items to buy: at most 2, only if the dish truly needs them"),
    steps: z.array(z.string()),
    ...(plan
      ? {
          makesLeftover: z
            .string()
            .describe("What this dish deliberately leaves for another day of the plan, e.g. 'extra roasted vegetables', or empty"),
          usesLeftover: z.string().describe("The exact makesLeftover text of another recipe this one reuses, or empty"),
        }
      : {}),
  });
}

export function recipeSetSchemaFor(inventoryNames: readonly string[], pantryIds: readonly string[], plan = false) {
  return z.object({ recipes: z.array(recipeSchemaFor(inventoryNames, pantryIds, plan)) });
}

const strings = z.array(z.string()).catch([]);

/** Reads an answer leniently: a name outside the enums becomes a validation issue, not a lost recipe. */
export const cookedRecipeSchema = z.object({
  title: z.string().min(1),
  pitch: z.string().catch(""),
  minutes: z.number().catch(30),
  servings: z.number().catch(2),
  equipment: strings,
  dishes: z.number().catch(1),
  diet: strings,
  uses: z
    .array(
      z.object({
        ingredient: z.string(),
        amount: z.string().catch(""),
        share: z.number().catch(0.5),
      }),
    )
    .catch([]),
  staples: strings,
  toBuy: strings,
  steps: strings,
  makesLeftover: z.string().optional().catch(undefined),
  usesLeftover: z.string().optional().catch(undefined),
});

export type CookedRecipe = z.infer<typeof cookedRecipeSchema>;

export function parseCookedRecipe(value: unknown): CookedRecipe | null {
  const parsed = cookedRecipeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Every recipe that parses; one malformed entry must not cost the others. */
export function parseCookedSet(rawText: string): CookedRecipe[] {
  try {
    const json = JSON.parse(rawText) as { recipes?: unknown };
    return (Array.isArray(json.recipes) ? json.recipes : []).flatMap((r) => {
      const recipe = parseCookedRecipe(r);
      return recipe ? [recipe] : [];
    });
  } catch {
    return [];
  }
}
