import { perceptionSchema, type Perception } from "../pantry/schema";
import type { Recipe } from "../pantry/recipe-schema";

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
  recipes?: { model: string; rawText: string; recipes: Recipe[]; ms: number; costUsd: number };
  plate?: { src: string; recipeTitle: string; ms: number; costUsd: number };
  totalCostUsd: number;
};

export function replayPerception(recording: Recording): Perception {
  return perceptionSchema.parse(JSON.parse(recording.perception.rawText));
}
