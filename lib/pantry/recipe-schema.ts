import { z } from "zod";

export const recipeSchema = z.object({
  title: z.string(),
  pitch: z.string().describe("One sentence on why this dish rescues what it rescues"),
  minutes: z.number().int(),
  equipment: z.array(z.string()),
  diet: z.array(z.enum(["vegetarian", "vegan", "gluten-free", "dairy-free"])),
  uses: z
    .array(z.object({ ingredient: z.string().describe("Exact name from the inventory"), amount: z.string() }))
    .describe("Inventory items this recipe uses"),
  extras: z.array(z.string()).describe("Staples assumed at home: oil, salt, pepper…"),
  steps: z.array(z.string()),
});

export const recipeSetSchema = z.object({ recipes: z.array(recipeSchema) });

export type Recipe = z.infer<typeof recipeSchema>;
