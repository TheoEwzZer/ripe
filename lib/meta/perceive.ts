import { z } from "zod";
import { perceptionSchema, type Perception } from "../pantry/schema";
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

export type PerceiveResult = {
  model: string;
  rawText: string;
  perception: Perception;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  ms: number;
};

export async function perceive(imageUrl: string, opts: { contributor?: boolean } = {}): Promise<PerceiveResult> {
  const model = opts.contributor ? MODELS.perceiveContributor : MODELS.perceive;
  const started = Date.now();

  const response = await metaClient().chat.completions.create({
    model,
    reasoning_effort: "low",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PERCEIVE_PROMPT },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "perception", strict: true, schema: z.toJSONSchema(perceptionSchema) },
    },
  });

  const rawText = response.choices[0]?.message.content ?? "";
  const perception = perceptionSchema.parse(JSON.parse(rawText));
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  return {
    model,
    rawText,
    perception,
    usage: { inputTokens, outputTokens, costUsd: tokenCostUsd(model, inputTokens, outputTokens) },
    ms: Date.now() - started,
  };
}
