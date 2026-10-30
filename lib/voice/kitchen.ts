import { z } from "zod";
import { ingredientCategories } from "../pantry/schema";
import { MAX_SERVINGS, MIN_SERVINGS, diets, equipmentModes, type CookFilters } from "../recipes/filters";

/**
 * What one spoken sentence asks of the kitchen. Names to remove are an enum
 * of this inventory, so Muse Spark can only take out what is there.
 */
export function kitchenIntentSchema(inventoryNames: readonly string[]) {
  const known = inventoryNames.length > 0 ? z.enum(inventoryNames as [string, ...string[]]) : z.string();
  return z.object({
    add: z
      .array(
        z.object({
          name: z.string().describe("Common name in English, singular, e.g. 'red pepper'"),
          quantity: z.string().describe("Amount said, e.g. 'half', '2', 'a bowl'"),
          category: z.enum(ingredientCategories),
          daysLeft: z.number().int().min(0).max(60).describe("Realistic days before it should be eaten; leftovers from yesterday keep 2"),
        }),
      )
      .describe("Food the person says they have that is not in the list"),
    remove: z.array(known).describe("Items from the list the person finished, ate, threw away or no longer has"),
    filters: z
      .object({
        emergency: z.boolean().describe("Use what is most urgent first"),
        maxMinutes: z.union([z.literal(10), z.literal(15), z.literal(30)]).nullable(),
        equipment: z.enum(equipmentModes).nullable().describe("one-pan when they want a single pan or no oven"),
        diet: z.array(z.enum(diets)),
        fewDishes: z.boolean(),
        servings: z.number().int().min(MIN_SERVINGS).max(MAX_SERVINGS).nullable(),
      })
      .nullable()
      .describe("Only when the person asks for recipes or sets cooking constraints, else null"),
    reply: z.string().describe("One short sentence confirming what changed, spoken back to the person"),
  });
}

export type KitchenIntent = z.infer<ReturnType<typeof kitchenIntentSchema>>;

const lenient = z.object({
  add: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.string().catch(""),
        category: z.enum(ingredientCategories).catch("other"),
        daysLeft: z.number().catch(3),
      }),
    )
    .catch([]),
  remove: z.array(z.string()).catch([]),
  filters: z
    .object({
      emergency: z.boolean().catch(false),
      maxMinutes: z
        .union([z.literal(10), z.literal(15), z.literal(30)])
        .nullable()
        .catch(null),
      equipment: z.enum(equipmentModes).nullable().catch(null),
      diet: z.array(z.enum(diets)).catch([]),
      fewDishes: z.boolean().catch(false),
      servings: z.number().nullable().catch(null),
    })
    .nullable()
    .catch(null),
  reply: z.string().catch(""),
});

/** Reads Muse Spark's answer leniently; a broken answer means "nothing to do". */
export function parseKitchenIntent(rawText: string): KitchenIntent {
  try {
    const parsed = lenient.parse(JSON.parse(rawText));
    return {
      ...parsed,
      add: parsed.add
        .filter((a) => a.name.trim())
        .slice(0, 12)
        .map((a) => ({
          ...a,
          name: a.name.trim().slice(0, 60),
          quantity: a.quantity.slice(0, 40),
          daysLeft: Math.max(0, Math.min(60, Math.round(a.daysLeft))),
        })),
      remove: [...new Set(parsed.remove)].slice(0, 12),
    };
  } catch {
    return { add: [], remove: [], filters: null, reply: "" };
  }
}

/** The filters a sentence asked for, on top of the servings already chosen when it names none. */
export function filtersFrom(intent: NonNullable<KitchenIntent["filters"]>, current: CookFilters): CookFilters {
  return {
    emergency: intent.emergency,
    maxMinutes: intent.maxMinutes ?? undefined,
    equipment: intent.equipment ?? undefined,
    diet: [...new Set(intent.diet)],
    fewDishes: intent.fewDishes,
    servings: Math.max(MIN_SERVINGS, Math.min(MAX_SERVINGS, Math.round(intent.servings ?? current.servings))),
  };
}

export function kitchenPrompt(
  transcript: string,
  inventory: readonly { name: string; quantity: string; daysLeft: number }[],
  locale: "en" | "fr",
) {
  const list = inventory.map((i) => `- ${i.name}${i.quantity ? ` (${i.quantity})` : ""}, ${i.daysLeft} days left`).join("\n") || "(empty)";
  return `You are Ripe, a kitchen assistant that helps cook what is about to go off.
The person spoke one sentence to the app. Turn it into changes to their food list or recipe request.

Their food list:
${list}

They said: "${transcript}"

Rules:
- add: food they say they have that is not in the list (leftovers, things the photo missed). Never add something already listed.
- remove: list items they ate, finished, used up, threw away or no longer have. Use the exact list names.
- filters: only if they ask what to cook or set constraints ("quick" means 15 minutes, "no oven" or "one pan" means one-pan, "veggie" means vegetarian, "for four" means 4 servings, "what's urgent" means emergency). Otherwise null.
- reply: one short friendly sentence in ${locale === "fr" ? "French" : "English"} saying what you did. If the sentence asks for nothing you can do, say so briefly.`;
}
