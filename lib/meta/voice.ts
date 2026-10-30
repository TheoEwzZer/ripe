import { z } from "zod";
import { kitchenIntentSchema, kitchenPrompt, parseKitchenIntent, type KitchenIntent } from "../voice/kitchen";
import { metaBaseUrl, metaClient } from "./client";
import { MODELS, VOICE_USD_PER_HOUR, tokenCostUsd } from "./models";

/** Reserved before a clip is transcribed: 12 seconds of audio, rounded up. */
export const TRANSCRIBE_RESERVE_USD = 0.001;
/** Reserved before Muse Spark reads a sentence; measured runs cost far less. */
export const INTERPRET_RESERVE_USD = 0.01;

export const voiceCostUsd = (ms: number) => (Math.floor(ms / 1000) * VOICE_USD_PER_HOUR) / 3600;

export type Transcript = { text: string; audioMs: number; ms: number; costUsd: number };

/** One clip to Muse Voice Transcribe: multipart `request` (JSON settings) and `audio` (WAV). */
export async function transcribe(
  wav: Blob,
  opts: { keywords?: readonly string[]; languages?: readonly string[] } = {},
): Promise<Transcript> {
  const started = Date.now();
  const form = new FormData();
  const request = {
    model: MODELS.transcribe,
    audioEncoding: "WAV",
    mode: "PUSH_TO_TALK",
    ...(opts.keywords?.length ? { keywords: [...new Set(opts.keywords)].slice(0, 100) } : {}),
    ...(opts.languages?.length ? { languageBias: opts.languages } : {}),
  };
  form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
  form.append("audio", new Blob([await wav.arrayBuffer()], { type: "audio/wav" }), "clip.wav");
  const response = await fetch(`${metaBaseUrl()}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, Accept: "application/json" },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Muse Voice answered ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as { transcript?: string; audioDurationMs?: number };
  const audioMs = Number(data.audioDurationMs ?? 0);
  return { text: (data.transcript ?? "").trim(), audioMs, ms: Date.now() - started, costUsd: voiceCostUsd(audioMs) };
}

export type Interpretation = { intent: KitchenIntent; rawText: string; ms: number; costUsd: number };

/** Muse Spark turns one sentence into list changes and recipe filters, as structured output. */
export async function interpretKitchen(
  transcript: string,
  inventory: readonly { name: string; quantity: string; daysLeft: number }[],
  locale: "en" | "fr",
): Promise<Interpretation> {
  const started = Date.now();
  const names = [...new Set(inventory.map((i) => i.name))];
  const response = await metaClient().chat.completions.create({
    model: MODELS.perceive,
    reasoning_effort: "low",
    messages: [{ role: "user", content: kitchenPrompt(transcript, inventory, locale) }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "kitchen_change", strict: true, schema: z.toJSONSchema(kitchenIntentSchema(names)) },
    },
  });
  const rawText = response.choices[0]?.message.content ?? "";
  const usage = response.usage;
  return {
    intent: parseKitchenIntent(rawText),
    rawText,
    ms: Date.now() - started,
    costUsd: usage ? tokenCostUsd(MODELS.perceive, usage.prompt_tokens, usage.completion_tokens) : INTERPRET_RESERVE_USD,
  };
}
