"use node";

import { v } from "convex/values";
import { SWEEP_RESERVE_USD, sweep as sweepStills } from "../lib/meta/sweep";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/**
 * After the first frame of a filmed scan is analysed, Muse Spark looks at a
 * few later frames for what the first one missed; then SAM tracks everything.
 */
export const sweep = internalAction({
  args: { scanId: v.id("scans") },
  returns: v.null(),
  handler: async (ctx, { scanId }) => {
    const data = await ctx.runQuery(internal.scans.forSweep, { scanId });
    if (!data) return null;
    let cost = 0;
    try {
      const urls: string[] = [];
      for (const still of data.stills) {
        const url = await ctx.storage.getUrl(still.storageId);
        if (url) urls.push(url);
      }
      if (urls.length !== data.stills.length) throw new Error("A frame of the video is gone");
      await ctx.runMutation(internal.spend.reserve, { label: "sweep", usd: SWEEP_RESERVE_USD });
      try {
        const result = await sweepStills(urls, data.known, data.place);
        cost = result.costUsd;
        await ctx.runMutation(internal.scans.addSeen, { scanId, items: result.items, costUsd: cost });
      } finally {
        await ctx.runMutation(internal.spend.settle, { estimateUsd: SWEEP_RESERVE_USD, actualUsd: cost });
      }
    } catch (error) {
      // What the first frame showed is still tracked.
      console.error("sweep failed", scanId, error);
      await ctx.runMutation(internal.scans.endSweep, { scanId });
    }
    return null;
  },
});
