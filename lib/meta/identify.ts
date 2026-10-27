import { z } from "zod";
import { perceivedIngredientSchema, type PerceivedIngredient } from "../pantry/schema";
import type { GridBox } from "../pipeline/geometry";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";

/** Worst case for one short answer about one item. */
export const IDENTIFY_RESERVE_USD = 0.01;

/**
 * Names the one item a user tapped, now outlined by SAM: same fields as the
 * perception step, so the item joins the inventory like any other.
 */
export async function identify(
  imageUrl: string,
  box: GridBox,
): Promise<{ item: PerceivedIngredient | null; costUsd: number }> {
  const response = await metaClient().chat.completions.create({
    model: MODELS.perceive,
    reasoning_effort: "low",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are a careful home cook. Look only at the region of this photo inside the box [${box.x_min}, ${box.y_min}, ${box.x_max}, ${box.y_max}] (x_min, y_min, x_max, y_max on a 0–1000 grid, (0,0) top-left). Describe the single food item there: name (common English name, singular), samPrompt (its plainest English name, 1 to 3 words), category, visible quantity, daysLeft before it should be eaten judged from what you see, freshnessCues (the visual evidence, a few words), dateRead (a legible printed date, else null) and bbox (repeat the box above). If the region holds no food, name it "not food".`,
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "ingredient", strict: true, schema: z.toJSONSchema(perceivedIngredientSchema) },
    },
  });

  const usage = response.usage;
  const costUsd = usage ? tokenCostUsd(MODELS.perceive, usage.prompt_tokens, usage.completion_tokens) : IDENTIFY_RESERVE_USD;
  const parsed = perceivedIngredientSchema.safeParse(JSON.parse(response.choices[0]?.message.content ?? "null"));
  if (!parsed.success || parsed.data.name.trim().toLowerCase() === "not food") return { item: null, costUsd };
  return { item: { ...parsed.data, bbox: box }, costUsd };
}
