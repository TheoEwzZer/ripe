import { perceptionSchema, type Perception } from "../pantry/schema";

/** One recorded Muse Wonder pass on this photo's untouched inventory, with its plates. */
export type RecordedCooking = {
  locale: "en" | "fr";
  /** lib/recipes/filters.ts filtersKey, lib/recipes/pantry.ts pantryKey, kitchenKey below. */
  filtersKey: string;
  pantryKey: string;
  kitchenKey: string;
  model: string;
  rawText: string;
  ms: number;
  costUsd: number;
  fix?: { rawText: string; ms: number; costUsd: number };
  /** Muse Image plates by recipe index, served from public/. */
  plates: ({ src: string; ms: number } | null)[];
};

/**
 * A recording keeps the raw model outputs for one photo. Replays run them
 * through the same pipeline and parsers as live calls, so the UI cannot tell
 * them apart.
 */
export type Recording = {
  id: string;
  source: "mock" | "live";
  createdAt: string;
  image: { src: string; width: number; height: number };
  perception: { model: string; rawText: string; ms: number; costUsd: number };
  /** Concept prompts, one per ingredient index. */
  segments: { ingredientIndex: number; prompt: string; encoding: "lossless" | "one_bit"; rawText: string; ms: number }[];
  /** The batched box prompt for ingredients the concept prompts missed. */
  boxFallback?: { ingredientIndexes: number[]; prompt: string; rawText: string; ms: number };
  cooking?: RecordedCooking[];
  /** Storage tips for this photo's most urgent items (lib/meta/tips.ts tipsKey), per language. */
  tips?: { locale: "en" | "fr"; key: string; rawText: string; ms: number; costUsd: number }[];
  totalCostUsd: number;
};

export function replayPerception(recording: Recording): Perception {
  return perceptionSchema.parse(JSON.parse(recording.perception.rawText));
}

/** The inventory a recording was cooked from: names, quantities and days, order-free. */
export function kitchenKey(kitchen: readonly { name: string; quantity: string; daysLeft: number }[]): string {
  return kitchen
    .map((i) => `${i.name.trim().toLowerCase()}:${i.quantity.trim()}:${i.daysLeft}`)
    .sort()
    .join("|");
}
