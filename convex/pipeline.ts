"use node";

import { ConvexError, v } from "convex/values";
import { IDENTIFY_RESERVE_USD, identify } from "../lib/meta/identify";
import { liveProvider } from "../lib/meta/live-provider";
import { SAM_USD_PER_IMAGE } from "../lib/meta/models";
import { segmentPoint } from "../lib/meta/segment";
import { pixelsToGrid, union } from "../lib/pipeline/geometry";
import { runPipeline } from "../lib/pipeline/run";
import { masksOf } from "../lib/pipeline/sam";
import type { VisionProvider } from "../lib/pipeline/types";
import { recordings } from "../lib/replay/catalog";
import { replayProvider } from "../lib/replay/provider";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
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

    const ids: Id<"ingredients">[] = [];
    try {
      const summary = await runPipeline(
        provider,
        { width: scan.width, height: scan.height },
        {
          perceivedItem: async (item, index) => {
            ids[index] = await ctx.runMutation(internal.scans.addIngredient, { scanId, order: index, item });
          },
          perceived: async () => {
            await ctx.runMutation(internal.scans.finishPerception, { scanId });
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

/**
 * The photo as the Meta API can fetch it: Convex storage for uploads, the
 * deployed site for bundled demo photos (PUBLIC_SITE_URL in the Convex env).
 */
export async function publicImageUrl(ctx: ActionCtx, source: Doc<"scans">["source"]): Promise<string | null> {
  if (source.kind === "upload") return await ctx.storage.getUrl(source.storageId);
  const site = process.env.PUBLIC_SITE_URL;
  return site ? new URL(source.imageSrc, site).href : null;
}

/** Tap to add: SAM outlines what is under the finger, then Muse Spark names it. */
export const tapAdd = internalAction({
  args: { ingredientId: v.id("ingredients"), x: v.number(), y: v.number() },
  returns: v.null(),
  handler: async (ctx, { ingredientId, x, y }) => {
    const scan = await ctx.runQuery(internal.scans.forTap, { ingredientId });
    const imageUrl = scan && (await publicImageUrl(ctx, scan.source));
    if (!scan || !imageUrl) {
      await ctx.runMutation(internal.scans.dropTap, { ingredientId });
      return null;
    }
    const size = { width: scan.width, height: scan.height };

    try {
      await ctx.runMutation(internal.spend.reserve, { label: "tap", usd: SAM_USD_PER_IMAGE + IDENTIFY_RESERVE_USD });
      const segmented = await segmentPoint(imageUrl, size, { x, y });
      const masks = masksOf(segmented.result);
      const bounds = union(masks.map((m) => m.bounds));
      if (!bounds) {
        await ctx.runMutation(internal.spend.settle, { estimateUsd: IDENTIFY_RESERVE_USD, actualUsd: 0 });
        await ctx.runMutation(internal.scans.dropTap, { ingredientId });
        return null;
      }
      const bbox = pixelsToGrid(bounds, size);
      await ctx.runMutation(internal.scans.saveTapMasks, { ingredientId, masks, bbox });

      const { item, costUsd } = await identify(imageUrl, bbox);
      await ctx.runMutation(internal.spend.settle, { estimateUsd: IDENTIFY_RESERVE_USD, actualUsd: costUsd });
      if (!item) {
        await ctx.runMutation(internal.scans.dropTap, { ingredientId });
        return null;
      }
      await ctx.runMutation(internal.scans.nameTap, {
        ingredientId,
        name: item.name,
        samPrompt: item.samPrompt,
        category: item.category,
        quantity: item.quantity,
        daysLeft: item.daysLeft,
        freshnessCues: item.freshnessCues,
        dateRead: item.dateRead,
      });
    } catch (error) {
      console.error("tap failed", ingredientId, error);
      await ctx.runMutation(internal.scans.dropTap, { ingredientId });
    }
    return null;
  },
});
