import type { Perception } from "../pantry/schema";

export type Perceived = {
  model: string;
  rawText: string;
  perception: Perception;
  ms: number;
  costUsd: number;
};

export type SamCall = { rawText: string; ms: number; costUsd: number };

/**
 * Where model outputs come from. `live` calls the Meta Model API; `replay`
 * serves a recording. The pipeline cannot tell them apart.
 */
export interface VisionProvider {
  readonly kind: "live" | "replay";
  perceive(): Promise<Perceived>;
  /** One concept per request: SAM 3.1 returns nothing for lists. */
  segmentConcept(ingredientIndex: number, nounPhrase: string): Promise<SamCall>;
  /** Box prompts built with buildObjectPrompt; object ids are ingredient indexes. */
  segmentBoxes(objectPrompt: string, ingredientIndexes: number[]): Promise<SamCall>;
}
