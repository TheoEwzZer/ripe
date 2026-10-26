import { z } from "zod";

export const ingredientCategories = [
  "produce",
  "fruit",
  "dairy",
  "egg",
  "meat",
  "fish",
  "bakery",
  "condiment",
  "drink",
  "leftover",
  "pantry",
  "other",
] as const;

/** One item Muse Spark sees in the photo. Coordinates use Meta's 0–1000 grid. */
export const perceivedIngredientSchema = z.object({
  name: z.string().describe("Common name in English, singular, e.g. 'zucchini'"),
  samPrompt: z
    .string()
    .describe("Short English noun phrase SAM can segment, e.g. 'green zucchini'. No lists, no verbs."),
  category: z.enum(ingredientCategories),
  quantity: z.string().describe("Visible amount, e.g. '2', 'half a bag', '~300 g'"),
  daysLeft: z.number().int().min(0).max(60).describe("Estimated days before it should be eaten"),
  freshnessCues: z.string().describe("What in the image supports the estimate: spots, wilting, dates read"),
  dateRead: z.string().nullable().describe("A best-before date printed and legible on the item, else null"),
  bbox: z.object({
    x_min: z.number().int(),
    y_min: z.number().int(),
    x_max: z.number().int(),
    y_max: z.number().int(),
  }),
});

export const perceptionSchema = z.object({
  scene: z.enum(["fridge", "pantry", "counter", "other"]),
  ingredients: z.array(perceivedIngredientSchema),
});

export type PerceivedIngredient = z.infer<typeof perceivedIngredientSchema>;
export type Perception = z.infer<typeof perceptionSchema>;
