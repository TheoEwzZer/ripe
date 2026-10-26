import { parseImageStream, type ImageSegmentationResult, type ResponsesEvent } from "@meta-sam/parser";
import { perceptionSchema, type Perception } from "@/lib/pantry/schema";
import type { Recipe } from "@/lib/pantry/recipe-schema";

/**
 * A recording keeps the raw model outputs for one photo. Replays run them
 * through the same parsers as live calls, so the UI cannot tell them apart.
 */
export type Recording = {
  id: string;
  source: "mock" | "live";
  createdAt: string;
  image: { src: string; width: number; height: number };
  perception: { model: string; rawText: string; ms: number; costUsd: number };
  segments: { ingredientIndex: number; prompt: string; encoding: "lossless" | "one_bit"; rawText: string; ms: number }[];
  recipes?: { model: string; rawText: string; recipes: Recipe[]; ms: number; costUsd: number };
  plate?: { src: string; recipeTitle: string; ms: number; costUsd: number };
  totalCostUsd: number;
};

export function replayPerception(recording: Recording): Perception {
  return perceptionSchema.parse(JSON.parse(recording.perception.rawText));
}

/** Feeds recorded SAM text through the parser as if it streamed, split into deltas like the API does. */
export async function replaySegment(rawText: string, chunkSize = 512): Promise<ImageSegmentationResult> {
  async function* events(): AsyncIterable<ResponsesEvent> {
    const lane = { item_id: "replay", output_index: 0, content_index: 0 };
    for (let i = 0; i < rawText.length; i += chunkSize) {
      yield { type: "response.output_text.delta", delta: rawText.slice(i, i + chunkSize), ...lane };
    }
    yield { type: "response.output_text.done", text: rawText, ...lane };
    yield { type: "response.completed" };
  }
  return parseImageStream(events()).finalResult;
}
