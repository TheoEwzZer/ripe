"use node";

import { ConvexError, v } from "convex/values";
import { COOK_RESERVE_USD, FIX_RESERVE_USD, SWAP_RESERVE_USD, cook, fixRecipes, swapIngredient, type CookRequest, type CookResult } from "../lib/meta/cook";
import { IMAGE_USD_PER_IMAGE } from "../lib/meta/models";
import { plate as imaginePlate } from "../lib/meta/plate";
import { filtersKey } from "../lib/recipes/filters";
import { pantryKey } from "../lib/recipes/pantry";
import { check, runCooking, type CheckedRecipe, type RecipeSource } from "../lib/recipes/run";
import type { CookedRecipe } from "../lib/recipes/schema";
import { recordings } from "../lib/replay/catalog";
import { closestCooking, findCooking, replayRecipeSource } from "../lib/replay/cooking";
import { kitchenKey } from "../lib/replay/recording";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { publicImageUrl } from "./pipeline";
import type { RecipeContent } from "./schema";

const MAX_LIVE_RUNS_PER_SESSION = 8;
/** A recorded plate still takes a moment, so the sheet shows Muse Image at work. */
const REPLAY_PLATE_MS = 3500;

const liveEnabled = () => Boolean(process.env.MODEL_API_KEY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) return String((error.data as { message?: string }).message ?? error.data);
  return error instanceof Error ? error.message : String(error);
}

const isBudgetError = (error: unknown) => error instanceof ConvexError && (error.data as { code?: string }).code === "budget";

function toContent({ recipe, uses, issues, score, fixed }: CheckedRecipe): RecipeContent {
  return {
    title: recipe.title.slice(0, 120),
    pitch: recipe.pitch.slice(0, 400),
    minutes: Math.max(0, Math.round(recipe.minutes)),
    servings: Math.max(1, Math.round(recipe.servings)),
    equipment: recipe.equipment.slice(0, 6),
    dishes: Math.max(0, Math.round(recipe.dishes)),
    diet: recipe.diet.slice(0, 6),
    uses: uses.slice(0, 20).map((u) => ({
      ingredientId: u.item ? (u.item.id as Id<"ingredients">) : undefined,
      ingredient: u.ingredient,
      amount: u.amount,
      share: u.share,
    })),
    staples: recipe.staples.slice(0, 20),
    toBuy: recipe.toBuy.slice(0, 6),
    steps: recipe.steps.slice(0, 14),
    score,
    issues,
    fixed,
  };
}

function fromContent(content: RecipeContent): CookedRecipe {
  const { title, pitch, minutes, servings, equipment, dishes, diet, uses, staples, toBuy, steps } = content;
  return { title, pitch, minutes, servings, equipment, dishes, diet, uses: uses.map(({ ingredient, amount, share }) => ({ ingredient, amount, share })), staples, toBuy, steps };
}

const nothing = (): CookResult => ({ model: "", rawText: "", recipes: [], costUsd: 0, ms: 0 });

/** Muse Wonder behind the daily cap: each call reserves its estimate, then settles on the measured cost. */
function liveSource(ctx: ActionCtx): RecipeSource {
  return {
    kind: "live",
    cook: async (req, handlers) => {
      const result = await cook(req, handlers);
      await ctx.runMutation(internal.spend.settle, { estimateUsd: COOK_RESERVE_USD, actualUsd: result.costUsd });
      return result;
    },
    fix: async (req, broken, handlers) => {
      try {
        await ctx.runMutation(internal.spend.reserve, { label: "fix", usd: FIX_RESERVE_USD });
      } catch {
        // No budget left for a correction: the recipes keep their warnings.
        return nothing();
      }
      const result = await fixRecipes(req, broken, handlers);
      await ctx.runMutation(internal.spend.settle, { estimateUsd: FIX_RESERVE_USD, actualUsd: result.costUsd });
      return result;
    },
  };
}

/** Recorded recipes for a demo photo, live Muse Wonder otherwise; a recording again if live is off or spent. */
export const run = internalAction({
  args: { runId: v.id("recipeRuns") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const data = await ctx.runQuery(internal.recipes.forRun, { runId });
    if (!data || data.status !== "cooking") return null;
    const req: CookRequest = { kitchen: data.kitchen, pantry: data.pantry, filters: data.filters, locale: data.locale };

    // The first demo photo with recorded recipes, even when a second demo photo joined the inventory.
    const recordingId = data.recordingIds.find((id: string) => (recordings[id]?.cooking?.length ?? 0) > 0);
    const recording = recordingId ? recordings[recordingId] : undefined;
    const replayOf = (recorded: NonNullable<ReturnType<typeof closestCooking>>) =>
      recordingId && recording ? { recordingId, cooking: recording.cooking!.indexOf(recorded) } : undefined;
    const exact =
      recording &&
      findCooking(recording, {
        locale: req.locale,
        filtersKey: filtersKey(req.filters),
        pantryKey: pantryKey(req.pantry),
        kitchenKey: kitchenKey(req.kitchen),
      });

    let source: RecipeSource;
    let begin: { source: "live" | "replay"; approximate: boolean; replayOf?: { recordingId: string; cooking: number } };
    try {
      if (exact) {
        source = replayRecipeSource(exact);
        begin = { source: "replay", approximate: false, replayOf: replayOf(exact) };
      } else {
        if (!liveEnabled() || data.liveRuns >= MAX_LIVE_RUNS_PER_SESSION) {
          throw new ConvexError({ code: "live_disabled", message: "Live cooking is not available" });
        }
        await ctx.runMutation(internal.spend.reserve, { label: "cook", usd: COOK_RESERVE_USD });
        source = liveSource(ctx);
        begin = { source: "live", approximate: false };
      }
    } catch (error) {
      const closest = recording && closestCooking(recording, req.locale);
      if (!closest) {
        await ctx.runMutation(internal.recipes.failRun, { runId, message: errorMessage(error) });
        return null;
      }
      source = replayRecipeSource(closest);
      begin = { source: "replay", approximate: true, replayOf: replayOf(closest) };
    }
    await ctx.runMutation(internal.recipes.begin, { runId, ...begin });

    try {
      const summary = await runCooking(source, req, {
        draft: async (order, title) => {
          await ctx.runMutation(internal.recipes.draft, { runId, order, title });
        },
        recipe: async (order, checked) => {
          await ctx.runMutation(internal.recipes.saveRecipe, { runId, order, content: toContent(checked) });
        },
        drop: async (order) => {
          await ctx.runMutation(internal.recipes.dropRecipe, { runId, order });
        },
        fixing: async (orders) => {
          await ctx.runMutation(internal.recipes.markFixing, { runId, orders });
        },
      });
      const costUsd = source.kind === "live" ? summary.cook.costUsd + (summary.fix?.costUsd ?? 0) : 0;
      if (summary.recipes.every((r) => !r)) throw new Error("Muse Wonder returned no recipe");
      await ctx.runMutation(internal.recipes.finishRun, { runId, costUsd });
    } catch (error) {
      console.error("cooking failed", runId, error);
      await ctx.runMutation(internal.recipes.failRun, { runId, message: isBudgetError(error) ? "budget" : errorMessage(error) });
    }
    return null;
  },
});

/** The finished dish, imagined by Muse Image from the person's own fridge photo. */
export const plate = internalAction({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const data = await ctx.runQuery(internal.recipes.forPlate, { recipeId });
    if (!data?.imagining) return null;

    const recorded =
      data.replayOf && !data.swapped ? recordings[data.replayOf.recordingId]?.cooking?.[data.replayOf.cooking]?.plates[data.order] : undefined;
    if (recorded) {
      await sleep(Math.min(recorded.ms, REPLAY_PLATE_MS));
      await ctx.runMutation(internal.recipes.savePlate, { recipeId, src: recorded.src, ms: recorded.ms });
      return null;
    }

    const imageUrl = await publicImageUrl(ctx, data.scanSource);
    if (!liveEnabled() || !imageUrl) {
      await ctx.runMutation(internal.recipes.failPlate, { recipeId });
      return null;
    }
    try {
      await ctx.runMutation(internal.spend.reserve, { label: "plate", usd: IMAGE_USD_PER_IMAGE });
      const { webp, ms } = await imaginePlate(imageUrl, data.title, data.ingredients);
      const storageId = await ctx.storage.store(new Blob([new Uint8Array(webp)], { type: "image/webp" }));
      await ctx.runMutation(internal.recipes.savePlate, { recipeId, storageId, ms });
    } catch (error) {
      console.error("plate failed", recipeId, error);
      await ctx.runMutation(internal.recipes.failPlate, { recipeId });
    }
    return null;
  },
});

/** Muse Wonder rewrites one recipe without an ingredient; Ripe checks and scores it again. */
export const swap = internalAction({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const data = await ctx.runQuery(internal.recipes.forSwap, { recipeId });
    if (!data) return null;
    const req: CookRequest = { kitchen: data.kitchen, pantry: data.pantry, filters: data.filters, locale: data.locale };
    try {
      await ctx.runMutation(internal.spend.reserve, { label: "swap", usd: SWAP_RESERVE_USD });
      const result = await swapIngredient(req, fromContent(data.content), data.ingredient);
      await ctx.runMutation(internal.spend.settle, { estimateUsd: SWAP_RESERVE_USD, actualUsd: result.costUsd });
      const fresh = result.recipes[0];
      if (!fresh) throw new Error("Muse Wonder returned no recipe");
      const kitchen = req.kitchen.filter((i) => i.name !== data.ingredient);
      await ctx.runMutation(internal.recipes.saveSwap, { recipeId, content: toContent(check(fresh, { ...req, kitchen })) });
    } catch (error) {
      console.error("swap failed", recipeId, error);
      await ctx.runMutation(internal.recipes.failSwap, { recipeId });
    }
    return null;
  },
});
