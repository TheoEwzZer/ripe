import type { VisionProvider } from "../pipeline/types";
import { SAM_USD_PER_IMAGE } from "./models";
import { perceive } from "./perceive";
import { segmentBoxes, segmentConcept } from "./segment";

/** Worst-case estimate reserved before a perception call; settled with the measured token cost. */
export const PERCEIVE_RESERVE_USD = 0.03;

export type LiveOptions = {
  /** Called before every paid request; throw to stop the run (budget cap). */
  reserve: (label: string, usd: number) => Promise<void> | void;
  /** Replaces an estimate with the measured cost once usage comes back. */
  settle?: (label: string, estimateUsd: number, actualUsd: number) => Promise<void> | void;
  contributor?: boolean;
};

/** The Meta Model API behind the pipeline's provider interface. `imageUrl` may be https or a data URL. */
export function liveProvider(imageUrl: string, options: LiveOptions): VisionProvider {
  const { reserve, settle, contributor } = options;

  return {
    kind: "live",
    async perceive() {
      await reserve("perceive", PERCEIVE_RESERVE_USD);
      const result = await perceive(imageUrl, { contributor });
      await settle?.("perceive", PERCEIVE_RESERVE_USD, result.usage.costUsd);
      return {
        model: result.model,
        rawText: result.rawText,
        perception: result.perception,
        ms: result.ms,
        costUsd: result.usage.costUsd,
      };
    },
    async segmentConcept(_index, nounPhrase) {
      await reserve("segment", SAM_USD_PER_IMAGE);
      const result = await segmentConcept(imageUrl, nounPhrase);
      return { rawText: result.rawText, ms: result.ms, costUsd: SAM_USD_PER_IMAGE };
    },
    async segmentBoxes(objectPrompt) {
      await reserve("segment-boxes", SAM_USD_PER_IMAGE);
      const result = await segmentBoxes(imageUrl, objectPrompt);
      return { rawText: result.rawText, ms: result.ms, costUsd: SAM_USD_PER_IMAGE };
    },
  };
}
