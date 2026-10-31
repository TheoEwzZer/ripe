import { z } from "zod";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";

/** Reserved before Muse Spark writes the tips; a short text answer. */
export const TIPS_RESERVE_USD = 0.01;
/** Tips cover the most urgent items only. */
export const MAX_TIP_ITEMS = 6;

export const storagePlaces = ["fridge", "crisper", "freezer", "counter", "pantry"] as const;
export const lateActions = ["cook_today", "freeze", "transform", "compost"] as const;

export function tipsSchemaFor(names: readonly string[]) {
  const item = names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string();
  return z.object({
    tips: z.array(
      z.object({
        item,
        where: z.enum(storagePlaces).describe("Where it keeps longest at home"),
        how: z.string().describe("One practical sentence: how to store it to keep it longer"),
        extraDays: z.number().int().min(0).max(30).describe("Days gained by storing it that way"),
        tooLate: z.object({
          action: z.enum(lateActions).describe("What to do when it is about to go off"),
          how: z.string().describe("One sentence: how to freeze, cook or transform it, or why to compost"),
        }),
      }),
    ),
  });
}

export type Tip = {
  item: string;
  where: (typeof storagePlaces)[number];
  how: string;
  extraDays: number;
  tooLate: { action: (typeof lateActions)[number]; how: string };
};

const lenient = z.object({
  tips: z
    .array(
      z.object({
        item: z.string(),
        where: z.enum(storagePlaces).catch("fridge"),
        how: z.string().catch(""),
        extraDays: z.number().catch(0),
        tooLate: z
          .object({ action: z.enum(lateActions).catch("cook_today"), how: z.string().catch("") })
          .catch({ action: "cook_today", how: "" }),
      }),
    )
    .catch([]),
});

/** Keeps only tips for the items asked about, once each, cleaned. */
export function parseTips(rawText: string, names: readonly string[]): Tip[] {
  try {
    const seen = new Set<string>();
    return lenient
      .parse(JSON.parse(rawText))
      .tips.filter((t) => names.includes(t.item) && !seen.has(t.item) && seen.add(t.item) && t.how.trim())
      .map((t) => ({
        ...t,
        how: t.how.trim().slice(0, 240),
        extraDays: Math.max(0, Math.min(30, Math.round(t.extraDays))),
        tooLate: { action: t.tooLate.action, how: t.tooLate.how.trim().slice(0, 240) },
      }));
  } catch {
    return [];
  }
}

export function tipsPrompt(items: readonly { name: string; quantity: string; daysLeft: number }[], locale: "en" | "fr"): string {
  const list = items.map((i) => `- ${i.name}${i.quantity ? ` (${i.quantity})` : ""}, about ${i.daysLeft} days left`).join("\n");
  return `You are a home cook who hates waste. For each of these items, say how to store it at home so it keeps longer, and what to do if it is about to go off.
${list}

- where: the best place at home (crisper = the fridge's vegetable drawer).
- how: one short, concrete sentence (e.g. "Wrap in a damp tea towel in the crisper").
- extraDays: honest days gained, 0 if storage changes nothing.
- tooLate: the best rescue when it is at the limit: cook_today, freeze (say how: blanch, slice, portion), transform (soup, pesto, compote, jam…) or compost only if it is unsafe to eat.
Write "how" texts in ${locale === "fr" ? "French" : "English"}. Use the exact item names given.`;
}

/** Muse Spark writes storage tips and last-minute rescues for the most urgent items. */
export async function writeTips(
  items: readonly { name: string; quantity: string; daysLeft: number }[],
  locale: "en" | "fr",
): Promise<{ tips: Tip[]; rawText: string; ms: number; costUsd: number }> {
  const started = Date.now();
  const names = items.map((i) => i.name);
  const response = await metaClient().chat.completions.create({
    model: MODELS.perceive,
    reasoning_effort: "low",
    messages: [{ role: "user", content: tipsPrompt(items, locale) }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "storage_tips", strict: true, schema: z.toJSONSchema(tipsSchemaFor(names)) },
    },
  });
  const rawText = response.choices[0]?.message.content ?? "";
  const usage = response.usage;
  return {
    tips: parseTips(rawText, names),
    rawText,
    ms: Date.now() - started,
    costUsd: usage ? tokenCostUsd(MODELS.perceive, usage.prompt_tokens, usage.completion_tokens) : TIPS_RESERVE_USD,
  };
}

/** The items tips are written for: the most urgent first, perception order breaking ties. */
export function pickUrgent<T extends { name: string; daysLeft: number }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...items]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.daysLeft - b.item.daysLeft || a.i - b.i)
    .map(({ item }) => item)
    .filter((item) => item.name.trim() && !seen.has(item.name) && seen.add(item.name))
    .slice(0, MAX_TIP_ITEMS);
}

/** Recorded tips are reused when the same urgent items are asked about again. */
export const tipsKey = (names: readonly string[]) => [...names].sort().join("|");
