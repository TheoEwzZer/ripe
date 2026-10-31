import OpenAI from "openai";
import { z } from "zod";
import { perceivedIngredientSchema, perceptionSchema, type Perception } from "../pantry/schema";
import { ArrayItemStream } from "../pipeline/json-stream";
import type { OnPerceivedItem } from "../pipeline/types";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";

export const PERCEIVE_PROMPT = `You are an object grounding expert and a careful home cook.
List every distinct food item visible in this photo of a fridge, pantry or counter. Do not miss objects, including items partly hidden behind others or inside clear containers and bags. Group identical items that sit together into one entry with a quantity.

For each item:
- name: common English name, singular.
- samPrompt: the plainest English name for it, 1 to 3 words, the way a shop label says it: "spinach", "cherry tomatoes", "milk carton", "kiwi". No colours, containers or other adjectives unless two different items would otherwise share the name. Never a list. A segmentation model searches the photo for exactly this phrase.
- daysLeft: realistic days before it should be eaten, judged from what you see (wilting, spots, opened packaging) and any legible date. 0 means today.
- freshnessCues: the visual evidence for that estimate, in a few words.
- dateRead: a printed best-before date only if you can actually read it, else null.
- bbox: the item's box on a 0–1000 grid, (0,0) top-left, (1000,1000) bottom-right.

Ignore the fridge itself, shelves, drawers and non-food objects.`;

/** Charged when the API returns no usage; on the high side of a measured 16-item photo. */
const UNKNOWN_USAGE_USD = 0.02;

export type Place = "fridge" | "pantry" | "freezer";

/** The same prompt for every photo, plus how long food keeps where it was taken. */
export const PLACE_HINTS: Record<Place, string> = {
  fridge: "This photo shows a fridge.",
  pantry: "This photo shows a pantry or a cupboard: dry and canned goods keep for weeks or months, fresh produce stored here still spoils.",
  freezer: "This photo shows a freezer: frozen food keeps for months, so give frozen items many days left (up to 60) unless they show freezer burn.",
};

export type PerceiveResult = {
  model: string;
  rawText: string;
  perception: Perception;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  ms: number;
};

/** Keeps every valid ingredient: one malformed entry must not cost the whole inventory. */
export function parsePerception(rawText: string): Perception {
  const json = JSON.parse(rawText) as { scene?: unknown; ingredients?: unknown };
  const scene = perceptionSchema.shape.scene.safeParse(json.scene);
  const ingredients = (Array.isArray(json.ingredients) ? json.ingredients : []).flatMap((item) => {
    const parsed = perceivedIngredientSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return { scene: scene.success ? scene.data : "other", ingredients };
}

/**
 * Muse Spark reads the photo and streams its JSON answer; each ingredient is
 * handed to `onItem` the moment its object closes, so segmentation can start
 * while the rest is still being written.
 */
export async function perceive(
  imageUrl: string,
  opts: { contributor?: boolean; onItem?: OnPerceivedItem; place?: Place } = {},
): Promise<PerceiveResult> {
  const model = opts.contributor ? MODELS.perceiveContributor : MODELS.perceive;
  const started = Date.now();
  const request = {
    model,
    reasoning_effort: "low" as const,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: opts.place ? `${PERCEIVE_PROMPT}
${PLACE_HINTS[opts.place]}` : PERCEIVE_PROMPT },
          { type: "image_url" as const, image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "perception", strict: true, schema: z.toJSONSchema(perceptionSchema) },
    },
  };

  let rawText = "";
  let usage: OpenAI.CompletionUsage | null = null;
  let emitted = 0;
  const items = new ArrayItemStream("ingredients");

  try {
    const stream = await metaClient().chat.completions.create({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        rawText += delta;
        for (const candidate of items.push(delta)) {
          const parsed = perceivedIngredientSchema.safeParse(candidate);
          if (parsed.success) await opts.onItem?.(parsed.data, emitted++);
        }
      }
      if (chunk.usage) usage = chunk.usage;
    }
  } catch (error) {
    // Fall back to one blocking call only when the API refuses streaming up front.
    if (rawText || !(error instanceof OpenAI.APIError && error.status === 400)) throw error;
    const response = await metaClient().chat.completions.create(request);
    rawText = response.choices[0]?.message.content ?? "";
    usage = response.usage ?? null;
  }

  const perception = parsePerception(rawText);
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    model,
    rawText,
    perception,
    usage: {
      inputTokens,
      outputTokens,
      costUsd: usage ? tokenCostUsd(model, inputTokens, outputTokens) : UNKNOWN_USAGE_USD,
    },
    ms: Date.now() - started,
  };
}
