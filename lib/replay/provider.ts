import type { SamCall, VisionProvider } from "../pipeline/types";
import { replayPerception, type Recording } from "./recording";

export type ReplayOptions = {
  /** 1 replays recorded latencies; higher is faster; Infinity skips waiting. */
  speed?: number;
  /** Perception is the slowest step; cap it so demos stay snappy. */
  maxPerceiveMs?: number;
  signal?: AbortSignal;
};

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Serves a recording with its recorded latencies. Prompts with no recording answer with zero matches. */
export function replayProvider(recording: Recording, options: ReplayOptions = {}): VisionProvider {
  const { speed = 1, maxPerceiveMs = 2500, signal } = options;
  const scaled = (ms: number) => ms / speed;
  const empty = (): SamCall => ({ rawText: "", ms: 0, costUsd: 0 });

  return {
    kind: "replay",
    async perceive(onItem) {
      const ms = Math.min(recording.perception.ms, maxPerceiveMs);
      const perception = replayPerception(recording);
      // Like the live stream: a first item after a short think, the rest spread over the answer.
      const count = perception.ingredients.length;
      const first = ms * 0.3;
      const step = count > 1 ? (ms - first) / (count - 1) : 0;
      let elapsed = 0;
      for (const [index, item] of perception.ingredients.entries()) {
        const at = first + index * step;
        await wait(scaled(at - elapsed), signal);
        elapsed = at;
        await onItem?.(item, index);
      }
      await wait(scaled(ms - elapsed), signal);
      return {
        model: recording.perception.model,
        rawText: recording.perception.rawText,
        perception,
        ms,
        costUsd: 0,
      };
    },
    async segmentConcept(ingredientIndex, nounPhrase) {
      const segment = recording.segments.find((s) => s.ingredientIndex === ingredientIndex && s.prompt === nounPhrase);
      if (!segment) return empty();
      await wait(scaled(segment.ms), signal);
      return { rawText: segment.rawText, ms: segment.ms, costUsd: 0 };
    },
    async segmentBoxes() {
      const fallback = recording.boxFallback;
      if (!fallback) return empty();
      await wait(scaled(fallback.ms), signal);
      return { rawText: fallback.rawText, ms: fallback.ms, costUsd: 0 };
    },
  };
}
