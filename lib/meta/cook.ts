import OpenAI from "openai";
import { z } from "zod";
import type { CookFilters } from "../recipes/filters";
import { stapleLabel } from "../recipes/pantry";
import { parseCookedSet, recipeSetSchemaFor, type CookedRecipe } from "../recipes/schema";
import { readRecipeStream, type RecipeStreamHandlers } from "../recipes/stream";
import { issueText, urgentIds, type Issue, type KitchenItem } from "../recipes/validate";
import { metaClient } from "./client";
import { MODELS, tokenCostUsd } from "./models";

export type CookRequest = {
  kitchen: KitchenItem[];
  pantry: string[];
  filters: CookFilters;
  locale: "en" | "fr";
};

export type CookResult = { model: string; rawText: string; recipes: CookedRecipe[]; costUsd: number; ms: number };

/** Charged when the API returns no usage; three measured recipes cost $0.032. */
const UNKNOWN_USAGE_USD = 0.05;
export const COOK_RESERVE_USD = 0.06;
export const FIX_RESERVE_USD = 0.05;
export const SWAP_RESERVE_USD = 0.03;

const urgentFirst = (kitchen: readonly KitchenItem[]) => [...kitchen].sort((a, b) => a.daysLeft - b.daysLeft);
const uniqueNames = (kitchen: readonly KitchenItem[]) => [...new Set(urgentFirst(kitchen).map((i) => i.name))];

function kitchenContext({ kitchen, pantry }: CookRequest): string {
  const lines = urgentFirst(kitchen)
    .map((i) => `- ${i.name}${i.quantity ? ` (${i.quantity})` : ""}: eat within ${i.daysLeft} day${i.daysLeft === 1 ? "" : "s"}`)
    .join("\n");
  const staples = pantry.map((id) => `- ${id}: ${stapleLabel(id, "en")}`).join("\n");
  return `Here is what is in my kitchen, most urgent first:
${lines}

My pantry always has (use these ids in "staples"):
${staples}
Water is always available.`;
}

function rules({ kitchen, filters, locale }: CookRequest): string {
  const urgent = urgentFirst(kitchen).filter((i) => urgentIds(kitchen).has(i.id));
  const lines = [
    `- uses: the kitchen items the recipe uses, with their exact names from my list, the amount, and share: the fraction of what I have that it uses, from 0 to 1.`,
    `- staples: only ids from my pantry list.`,
    `- toBuy: anything else the dish needs, at most 2 items. Prefer recipes that need nothing.`,
    `- minutes counts prep and cooking. dishes counts the pots, pans, trays and baking dishes used. equipment lists the appliances used. diet lists the diets the recipe fits.`,
    `- 4 to 8 short steps.`,
    filters.emergency && `- Emergency mode: each recipe must use at least two of these most urgent items: ${[...new Set(urgent.map((i) => i.name))].join(", ")}.`,
    filters.maxMinutes && `- Each recipe takes ${filters.maxMinutes} minutes or less, prep included.`,
    filters.equipment === "microwave" && `- Cook with the microwave only.`,
    filters.equipment === "air-fryer" && `- Cook with the air fryer only.`,
    filters.equipment === "one-pan" && `- Cook in a single pan on the hob: no oven, one dish to wash.`,
    filters.fewDishes && `- Use at most 2 pots, pans or trays.`,
    ...filters.diet.map((d) => `- Every recipe must be ${d}.`),
    `- Write title, pitch, amounts, toBuy and steps in ${locale === "fr" ? "French" : "English"}.`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function cookPrompt(req: CookRequest): string {
  return `You are a home cook who hates waste.
${kitchenContext(req)}

Suggest 3 different recipes for ${req.filters.servings} ${req.filters.servings === 1 ? "person" : "people"} that use the most urgent items first.
${rules(req)}`;
}

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Streams a Wonder answer through the recipe reader; falls back to one blocking call if streaming is refused. */
async function streamRecipes(
  messages: Message[],
  names: readonly string[],
  pantry: readonly string[],
  handlers: RecipeStreamHandlers,
): Promise<CookResult> {
  const started = Date.now();
  const request = {
    model: MODELS.cook,
    reasoning_effort: "low" as const,
    messages,
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "recipes", strict: true, schema: z.toJSONSchema(recipeSetSchemaFor(names, pantry)) },
    },
  };

  let usage: OpenAI.CompletionUsage | null = null;
  let streamed = false;
  async function* deltas() {
    const stream = await metaClient().chat.completions.create({ ...request, stream: true, stream_options: { include_usage: true } });
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        streamed = true;
        yield delta;
      }
    }
  }

  let rawText: string;
  try {
    rawText = await readRecipeStream(deltas(), handlers);
  } catch (error) {
    if (streamed || !(error instanceof OpenAI.APIError && error.status === 400)) throw error;
    const response = await metaClient().chat.completions.create(request);
    usage = response.usage ?? null;
    rawText = await readRecipeStream([response.choices[0]?.message.content ?? ""], handlers);
  }

  const final = usage as OpenAI.CompletionUsage | null;
  return {
    model: MODELS.cook,
    rawText,
    recipes: parseCookedSet(rawText),
    costUsd: final ? tokenCostUsd(MODELS.cook, final.prompt_tokens, final.completion_tokens) : UNKNOWN_USAGE_USD,
    ms: Date.now() - started,
  };
}

/** Three recipes, streamed: each card fills while Muse Wonder writes. */
export function cook(req: CookRequest, handlers: RecipeStreamHandlers = {}): Promise<CookResult> {
  return streamRecipes([{ role: "user", content: cookPrompt(req) }], uniqueNames(req.kitchen), req.pantry, handlers);
}

/** One correction round for the recipes Ripe's checks rejected, in the same order. */
export function fixRecipes(
  req: CookRequest,
  broken: { recipe: CookedRecipe; issues: Issue[] }[],
  handlers: RecipeStreamHandlers = {},
): Promise<CookResult> {
  const problems = broken
    .map(({ recipe, issues }, i) => `${i + 1}. "${recipe.title}": ${issues.map(issueText).join("; ")}.`)
    .join("\n");
  return streamRecipes(
    [
      { role: "user", content: cookPrompt(req) },
      { role: "assistant", content: JSON.stringify({ recipes: broken.map((b) => b.recipe) }) },
      {
        role: "user",
        content: `These recipes break my rules:
${problems}
Rewrite exactly these ${broken.length} recipe${broken.length === 1 ? "" : "s"}, in the same order, fixing every problem and keeping the rest of each dish.`,
      },
    ],
    uniqueNames(req.kitchen),
    req.pantry,
    handlers,
  );
}

/** Rewrites one recipe without an ingredient the person does not want or does not have. */
export async function swapIngredient(req: CookRequest, recipe: CookedRecipe, ingredient: string): Promise<CookResult> {
  const kitchen = req.kitchen.filter((i) => i.name !== ingredient);
  const swapReq = { ...req, kitchen };
  return streamRecipes(
    [
      {
        role: "user",
        content: `You are a home cook who hates waste.
${kitchenContext(swapReq)}

Here is a recipe for ${req.filters.servings} ${req.filters.servings === 1 ? "person" : "people"}:
${JSON.stringify(recipe)}

Rewrite it without "${ingredient}": replace it with something else from my kitchen or pantry, or leave it out, and keep the spirit of the dish. Return it as the only recipe.
${rules(swapReq)}`,
      },
    ],
    uniqueNames(kitchen),
    req.pantry,
    {},
  );
}
