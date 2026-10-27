"use node";

import { ConvexError, v } from "convex/values";
import { liveProvider } from "../lib/meta/live-provider";
import { SAM_USD_PER_IMAGE } from "../lib/meta/models";
import { runPipeline } from "../lib/pipeline/run";
import type { VisionProvider } from "../lib/pipeline/types";
import { recordings } from "../lib/replay/catalog";
import { replayProvider } from "../lib/replay/provider";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";

/** SAM calls are cheap and many; reserve them in blocks so parallel requests don't contend on one row. */
const SAM_BLOCK_USD = SAM_USD_PER_IMAGE * 8;

function budgetGuard(ctx: ActionCtx) {
  let prepaid = 0;
  return {
    reserve: async (label: string, usd: number): Promise<void> => {
      if (label === "perceive") {
        await ctx.runMutation(internal.spend.reserve, { label, usd });
        return;
      }
      if (prepaid < usd) {
        await ctx.runMutation(internal.spend.reserve, { label, usd: SAM_BLOCK_USD });
        prepaid += SAM_BLOCK_USD;
      }
      prepaid -= usd;
    },
    settle: async (_label: string, estimateUsd: number, actualUsd: number): Promise<void> => {
      await ctx.runMutation(internal.spend.settle, { estimateUsd, actualUsd });
    },
    /** Gives back what was reserved but not used. */
    refund: async (): Promise<void> => {
      if (prepaid > 0) await ctx.runMutation(internal.spend.settle, { estimateUsd: prepaid, actualUsd: 0 });
      prepaid = 0;
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) return String((error.data as { message?: string }).message ?? error.data);
  return error instanceof Error ? error.message : String(error);
}

/** Perceive → segment (concept, then box fallback), writing each step so every screen sees it live. */
export const run = internalAction({
  args: { scanId: v.id("scans") },
  returns: v.null(),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.runQuery(internal.scans.forPipeline, { scanId });
    if (!scan || scan.status !== "perceiving") return null;

    const guard = budgetGuard(ctx);
    let provider: VisionProvider;
    if (scan.source.kind === "replay") {
      const recording = recordings[scan.source.recordingId];
      if (!recording) {
        await ctx.runMutation(internal.scans.fail, { scanId, message: "Unknown recording" });
        return null;
      }
      provider = replayProvider(recording);
    } else {
      const imageUrl = await ctx.storage.getUrl(scan.source.storageId);
      if (!imageUrl) {
        await ctx.runMutation(internal.scans.fail, { scanId, message: "The photo is gone" });
        return null;
      }
      provider = liveProvider(imageUrl, guard);
    }

    let ids: Id<"ingredients">[] = [];
    try {
      const summary = await runPipeline(
        provider,
        { width: scan.width, height: scan.height },
        {
          perceived: async ({ perception }) => {
            ids = await ctx.runMutation(internal.scans.savePerception, { scanId, ingredients: perception.ingredients });
          },
          masks: async (index, masks, via) => {
            await ctx.runMutation(internal.scans.saveMasks, { scanId, ingredientId: ids[index], via, masks });
          },
          unsegmented: async (index) => {
            await ctx.runMutation(internal.scans.markUnsegmented, { ingredientId: ids[index] });
          },
        },
      );
      await ctx.runMutation(internal.scans.finish, { scanId, costUsd: summary.costUsd });
    } catch (error) {
      console.error("pipeline failed", scanId, error);
      await ctx.runMutation(internal.scans.fail, { scanId, message: errorMessage(error) });
    } finally {
      await guard.refund();
    }
    return null;
  },
});
