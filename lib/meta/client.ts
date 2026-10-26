import OpenAI from "openai";

export const META_BASE_URL = "https://api.meta.ai/v1";

export function hasMetaKey(): boolean {
  return Boolean(process.env.MODEL_API_KEY);
}

let cached: OpenAI | null = null;

/** OpenAI SDK pointed at the Meta Model API. Server-side only: the key never reaches the browser. */
export function metaClient(): OpenAI {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error("MODEL_API_KEY is not set. Use the recorded fixtures (RIPE_REPLAY=1) until a key is available.");
  }
  cached ??= new OpenAI({ apiKey, baseURL: META_BASE_URL, maxRetries: 2, timeout: 90_000 });
  return cached;
}
