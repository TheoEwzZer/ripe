/** Model ids and list prices from dev.meta.ai/docs/pricing-rate-limits (checked 2026-10-26). */
export const MODELS = {
  perceive: "muse-spark-1.3",
  /** 12x cheaper, but Meta may train on the request. Opt-in only via META_CONTRIBUTOR=1. */
  perceiveContributor: "muse-spark-1.3-contributor",
  segment: "sam-3.1",
  cook: "muse-wonder-1.0",
  plate: "muse-image-1.0",
  transcribe: "muse-voice-transcribe-1.0",
} as const;

const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  "muse-wonder-1.0": { input: 4, output: 20 },
  "muse-spark-1.3": { input: 1.25, output: 4.25 },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2 },
};

export const SAM_USD_PER_IMAGE = 2.5 / 1000;
export const IMAGE_USD_PER_IMAGE = 0.01;
/** Billed per whole second of audio, streaming or not (dev.meta.ai/docs/speech-to-text). */
export const VOICE_USD_PER_HOUR = 0.18;

export function tokenCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = TOKEN_PRICES[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
