import { z } from "zod";
import { recipeSetSchema, type Recipe } from "../pantry/recipe-schema";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";

export type InventoryLine = { name: string; quantity: string; daysLeft: number };

export type CookFilters = {
  emergency?: boolean;
  maxMinutes?: number;
  equipment?: string;
  diet?: string[];
};

export function cookPrompt(inventory: InventoryLine[], filters: CookFilters, locale: "en" | "fr"): string {
  const lines = inventory.map((i) => `- ${i.name} (${i.quantity}), eat within ${i.daysLeft} day(s)`).join("\n");
  const rules = [
    filters.emergency && "Emergency mode: each recipe must use at least two of the five most urgent items.",
    filters.maxMinutes && `Each recipe takes ${filters.maxMinutes} minutes or less, prep included.`,
    filters.equipment && `Only equipment available: ${filters.equipment}.`,
    filters.diet?.length && `Diet: ${filters.diet.join(", ")}.`,
  ].filter(Boolean);

  return `You are a home cook who hates waste. Here is what is in my kitchen, most urgent first:
${lines}

Suggest 3 different recipes that use the most urgent items first. Use exact inventory names in "uses". Assume only basic staples (oil, salt, pepper, common spices) beyond the inventory.
${rules.join("\n")}
Write titles, pitch and steps in ${locale === "fr" ? "French" : "English"}.`;
}

export async function cook(inventory: InventoryLine[], filters: CookFilters, locale: "en" | "fr" = "en") {
  const started = Date.now();
  const response = await metaClient().chat.completions.create({
    model: MODELS.cook,
    reasoning_effort: "low",
    messages: [{ role: "user", content: cookPrompt(inventory, filters, locale) }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "recipes", strict: true, schema: z.toJSONSchema(recipeSetSchema) },
    },
  });

  const rawText = response.choices[0]?.message.content ?? "";
  const recipes: Recipe[] = recipeSetSchema.parse(JSON.parse(rawText)).recipes;
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  return {
    model: MODELS.cook,
    rawText,
    recipes,
    usage: { inputTokens, outputTokens, costUsd: tokenCostUsd(MODELS.cook, inputTokens, outputTokens) },
    ms: Date.now() - started,
  };
}
