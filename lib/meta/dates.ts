import { z } from "zod";
import type { GridBox } from "../pipeline/geometry";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";

/** Reserved before a label is read; a photo plus a short answer. */
export const DATE_RESERVE_USD = 0.02;

export const dateKinds = ["use_by", "best_before", "packed", "other"] as const;
export type DateKind = (typeof dateKinds)[number];

export const printedDateSchema = z.object({
  found: z.boolean().describe("A date is printed and legible"),
  date: z.string().nullable().describe("The date as YYYY-MM-DD, or null"),
  kind: z
    .enum(dateKinds)
    .nullable()
    .describe("use_by for 'use by'/'à consommer jusqu'au', best_before for 'best before'/'à consommer de préférence avant'"),
  text: z.string().describe("The date exactly as printed, or empty"),
});

export type PrintedDate = z.infer<typeof printedDateSchema>;

const lenient = z.object({
  found: z.boolean().catch(false),
  date: z.string().nullable().catch(null),
  kind: z.enum(dateKinds).nullable().catch(null),
  text: z.string().catch(""),
});

export function parsePrintedDate(rawText: string): PrintedDate {
  try {
    const read = lenient.parse(JSON.parse(rawText));
    const valid = read.date !== null && /^\d{4}-\d{2}-\d{2}$/.test(read.date) && !Number.isNaN(Date.parse(read.date));
    return { ...read, found: read.found && valid, date: valid ? read.date : null, text: read.text.slice(0, 60) };
  } catch {
    return { found: false, date: null, kind: null, text: "" };
  }
}

/**
 * Days from today until a use-by or best-before date; a packing date says
 * nothing about what is left. Dates in the past mean "today".
 */
export function daysUntil(read: PrintedDate, today: string): number | null {
  if (!read.found || !read.date || read.kind === "packed") return null;
  const days = Math.round((Date.parse(read.date) - Date.parse(today)) / 86_400_000);
  return Math.max(0, Math.min(60, days));
}

export function datePrompt(name: string, today: string, box: GridBox | null): string {
  const where = box
    ? `Look only at the ${name} inside the box (${box.x_min}, ${box.y_min}) to (${box.x_max}, ${box.y_max}) on a 0–1000 grid, (0,0) top-left.`
    : `The photo is a close-up of the ${name} packaging.`;
  return `You read dates printed on food packaging. Today is ${today}.
${where}
Find the use-by or best-before date (or, failing that, a packing date) printed on it. If the year is missing, use the nearest year that makes sense for food in a kitchen today. Never guess a date you cannot read: then found is false.`;
}

/** Muse Spark reads the printed date, as structured output. */
export async function readPrintedDate(
  imageUrl: string,
  opts: { name: string; today: string; box: GridBox | null },
): Promise<{ read: PrintedDate; rawText: string; ms: number; costUsd: number }> {
  const started = Date.now();
  const response = await metaClient().chat.completions.create({
    model: MODELS.perceive,
    reasoning_effort: "low",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: datePrompt(opts.name, opts.today, opts.box) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "printed_date", strict: true, schema: z.toJSONSchema(printedDateSchema) },
    },
  });
  const rawText = response.choices[0]?.message.content ?? "";
  const usage = response.usage;
  return {
    read: parsePrintedDate(rawText),
    rawText,
    ms: Date.now() - started,
    costUsd: usage ? tokenCostUsd(MODELS.perceive, usage.prompt_tokens, usage.completion_tokens) : DATE_RESERVE_USD,
  };
}
