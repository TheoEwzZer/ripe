import { z } from "zod";
import { perceivedIngredientSchema, type PerceivedIngredient } from "../pantry/schema";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";
import { PERCEIVE_PROMPT, PLACE_HINTS, type Place } from "./perceive";

/**
 * A filmed fridge is more than its first frame: a few later frames go to Muse
 * Spark in one call, with what the first frame already showed, and only the
 * items it had not seen come back, each on the frame where it shows best.
 */

/** Reserved before the call: a few images and a short list. */
export const SWEEP_RESERVE_USD = 0.04;
export const MAX_STILLS = 3;
const MAX_FOUND = 16;

export const sweepSchema = z.object({
  ingredients: z.array(
    perceivedIngredientSchema.extend({
      image: z.number().int().min(1).max(MAX_STILLS).describe("Which photo (1, 2 or 3) shows the item best; bbox is on that photo"),
    }),
  ),
});

export type SweptItem = PerceivedIngredient & { image: number };

export function sweepPrompt(known: readonly string[], stills: number, place?: Place): string {
  const seen = known.length ? known.map((n) => `- ${n}`).join("\n") : "- (nothing yet)";
  return `${PERCEIVE_PROMPT}
${place ? PLACE_HINTS[place] : ""}

These ${stills} photos are later frames of one video panning across the same place, in order. The first frame already gave this list:
${seen}

List only the food items that are visible in these frames and are NOT in that list. The same item seen from another angle, closer or partly hidden is already listed: leave it out. If nothing is new, return an empty list.
For each new item, image is the number of the photo (1 to ${stills}) where it shows best, and bbox is its box on that photo.`;
}

/** Keeps every valid entry that points at one of the photos and is not already known by name. */
export function parseSweep(rawText: string, stills: number, known: readonly string[]): SweptItem[] {
  const key = (name: string) => name.trim().toLowerCase().replace(/(es|s)$/, "");
  const seen = new Set(known.map(key));
  try {
    const json = JSON.parse(rawText) as { ingredients?: unknown };
    const out: SweptItem[] = [];
    for (const entry of Array.isArray(json.ingredients) ? json.ingredients : []) {
      const parsed = sweepSchema.shape.ingredients.element.safeParse(entry);
      if (!parsed.success || parsed.data.image > stills || !parsed.data.name.trim()) continue;
      const k = key(parsed.data.name);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(parsed.data);
    }
    return out.slice(0, MAX_FOUND);
  } catch {
    return [];
  }
}

export async function sweep(
  stillUrls: readonly string[],
  known: readonly string[],
  place?: Place,
): Promise<{ items: SweptItem[]; rawText: string; costUsd: number; ms: number }> {
  const started = Date.now();
  const response = await metaClient().chat.completions.create({
    model: MODELS.perceive,
    reasoning_effort: "low",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: sweepPrompt(known, stillUrls.length, place) },
          ...stillUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "sweep", strict: true, schema: z.toJSONSchema(sweepSchema) } },
  });
  const rawText = response.choices[0]?.message.content ?? "";
  const usage = response.usage;
  return {
    items: parseSweep(rawText, stillUrls.length, known),
    rawText,
    costUsd: usage ? tokenCostUsd(MODELS.perceive, usage.prompt_tokens, usage.completion_tokens) : SWEEP_RESERVE_USD,
    ms: Date.now() - started,
  };
}
