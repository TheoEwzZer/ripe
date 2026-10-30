import { z } from "zod";
import { ingredientCategories } from "../pantry/schema";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";

/** Reserved before a receipt is read: a tall photo and a list. */
export const RECEIPT_RESERVE_USD = 0.03;
const MAX_LINES = 40;

export const receiptSchema = z.object({
  date: z.string().nullable().describe("Purchase date as YYYY-MM-DD, or null if not printed"),
  store: z.string().describe("Store name, or empty"),
  items: z
    .array(
      z.object({
        name: z.string().describe("Common food name in English, singular, e.g. 'chicken breast'"),
        quantity: z.string().describe("Amount bought, e.g. '2', '1 kg', '4 x 125 g'"),
        category: z.enum(ingredientCategories),
        daysLeft: z.number().int().min(0).max(60).describe("Days left from today, given the purchase date and how long it keeps once home"),
      }),
    )
    .describe("Food lines only: no bags, deposits, discounts, cleaning products or toiletries"),
});

export type Receipt = z.infer<typeof receiptSchema>;

const lenient = z.object({
  date: z.string().nullable().catch(null),
  store: z.string().catch(""),
  items: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.string().catch(""),
        category: z.enum(ingredientCategories).catch("other"),
        daysLeft: z.number().catch(5),
      }),
    )
    .catch([]),
});

export function parseReceipt(rawText: string): Receipt {
  try {
    const read = lenient.parse(JSON.parse(rawText));
    return {
      date: read.date && /^\d{4}-\d{2}-\d{2}$/.test(read.date) ? read.date : null,
      store: read.store.slice(0, 60),
      items: read.items
        .filter((i) => i.name.trim())
        .slice(0, MAX_LINES)
        .map((i) => ({
          name: i.name.trim().slice(0, 60),
          quantity: i.quantity.slice(0, 40),
          category: i.category,
          daysLeft: Math.max(0, Math.min(60, Math.round(i.daysLeft))),
        })),
    };
  } catch {
    return { date: null, store: "", items: [] };
  }
}

export function receiptPrompt(today: string): string {
  return `You read supermarket receipts for a kitchen app that fights food waste. Today is ${today}.
List every food or drink line on this receipt. Skip bags, deposits, discounts, loyalty lines, cleaning products, toiletries and anything not eaten.
Abbreviated product names are common ("TOM GRAPPE", "YAOURT NAT 4X125"): write the plain food name in English, singular.
For daysLeft, start from the purchase date and how long that food keeps at home (fresh fish 1–2 days, salad 3–4, yogurt about 2 weeks, eggs 3 weeks, pasta months, capped at 60), then subtract the days since purchase.`;
}

/** Muse Spark reads a receipt photo into food lines with an estimated freshness. */
export async function readReceipt(
  imageUrl: string,
  today: string,
): Promise<{ receipt: Receipt; rawText: string; ms: number; costUsd: number }> {
  const started = Date.now();
  const response = await metaClient().chat.completions.create({
    model: MODELS.perceive,
    reasoning_effort: "low",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: receiptPrompt(today) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "receipt", strict: true, schema: z.toJSONSchema(receiptSchema) } },
  });
  const rawText = response.choices[0]?.message.content ?? "";
  const usage = response.usage;
  return {
    receipt: parseReceipt(rawText),
    rawText,
    ms: Date.now() - started,
    costUsd: usage ? tokenCostUsd(MODELS.perceive, usage.prompt_tokens, usage.completion_tokens) : RECEIPT_RESERVE_USD,
  };
}
